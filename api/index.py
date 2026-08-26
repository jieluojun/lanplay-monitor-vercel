#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vercel Serverless 入口（薄适配层，不修改 main.py / script.js）。

职责：
1. import 原始 main.py，复用 MonitorHandler。
2. 数据持久化后端（二选一，凭据均来自 OS 环境变量）：
   - Vercel Blob：配置 BLOB_READ_WRITE_TOKEN；
   - Cloudflare R2：配置 R2_PERSIST_*（缺省回退 R2_*）环境变量；
   由 PERSIST_PROVIDER 选择（auto=默认，Blob 优先，兼容旧部署）。
3. 启用持久化后：
   - 用「内存虚拟文件系统」接管 env/servers/chinese_db 的读写；
   - 读：内存（冷启动从远端存储 / 部署包填充）；
   - 写：更新内存并直接 PUT 到远端存储（不写 /tmp、不落盘）；
4. 未启用任何持久化时退回 /tmp 文件（与旧行为兼容）。
5. 时区 Asia/Shanghai；冷启动拉 GitHub 远程列表并回写存储。
"""

from __future__ import annotations

import os
import time

os.environ.setdefault("TZ", "Asia/Shanghai")
try:
    time.tzset()
except Exception:
    pass

import builtins
import hashlib
import hmac
import io
import json
import shutil
import sys
import threading
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime as _dt_cls, timezone as _dt_tz, timedelta as _dt_td
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Callable

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main as _app  # noqa: E402

# -----------------------------------------------------------------------
# 时区补丁
# -----------------------------------------------------------------------
_SH_TZ = _dt_tz(_dt_td(hours=8))


def _format_log_time_shanghai(timestamp: float, include_date: bool = False) -> str:
    dt_utc = _dt_cls.fromtimestamp(timestamp, tz=_dt_tz.utc)
    dt_sh = dt_utc.astimezone(_SH_TZ)
    period = "上午" if dt_sh.hour < 12 else "下午"
    clock = dt_sh.strftime("%I:%M:%S")
    return f"{dt_sh.strftime('%m-%d')} {period} {clock}" if include_date else f"{period} {clock}"


_app._format_log_time = _format_log_time_shanghai


def _log_capturer_format_shanghai(entry):
    text, _first, last = entry
    dt_utc = _dt_cls.fromtimestamp(last, tz=_dt_tz.utc)
    dt_sh = dt_utc.astimezone(_SH_TZ)
    now_utc = _dt_cls.now(_dt_tz.utc)
    now_sh = now_utc.astimezone(_SH_TZ)
    ts = _format_log_time_shanghai(last, include_date=dt_sh.date() != now_sh.date())
    return f"{text} | 更新于 {ts}"


try:
    _app.log_capturer._format = _log_capturer_format_shanghai
except Exception as exc:
    print(f"[适配器] 替换 LogCapturer._format 失败（不影响功能）: {exc!r}", flush=True)

try:
    print(
        f"[适配器] 启动 Vercel 函数 cwd={os.getcwd()} "
        f"vercel_region={os.environ.get('VERCEL_REGION', '?')} "
        f"tz={time.tzname} python={sys.version.split()[0]}",
        flush=True,
    )
except Exception:
    pass

_app.REMOTE_UPDATE_PROXY = ""

# ===========================================================================
# 持久化后端选择：Vercel Blob（对齐 @vercel/blob）或 Cloudflare R2（S3 API）
# ===========================================================================
def _env_first(*names: str, default: str = "") -> str:
    """返回第一个非空环境变量（去空白）。"""
    for _n in names:
        _v = (os.environ.get(_n) or "").strip()
        if _v:
            return _v
    return default


_BLOB_API = (os.environ.get("BLOB_API_URL") or "https://vercel.com/api/blob").strip().rstrip("/")
_BLOB_TOKEN = (os.environ.get("BLOB_READ_WRITE_TOKEN") or "").strip()
_BLOB_ACCESS = (os.environ.get("BLOB_ACCESS") or "private").strip().lower()
if _BLOB_ACCESS not in ("private", "public"):
    _BLOB_ACCESS = "private"
_BLOB_PREFIX = (os.environ.get("BLOB_PREFIX") or "lanplay/").strip()
if _BLOB_PREFIX and not _BLOB_PREFIX.endswith("/"):
    _BLOB_PREFIX += "/"
_BLOB_API_VERSION = (os.environ.get("BLOB_API_VERSION") or "12").strip() or "12"
_blob_effective_access = _BLOB_ACCESS

# ---- Cloudflare R2 数据持久化（与 Blob 二选一）----
# 凭据只从 OS 环境变量读取（R2_PERSIST_*，缺省回退聊天媒体用的 R2_*）：
# env.json 本身就存在 R2 里，冷启动必须先有凭据才能读到它（避免鸡生蛋），
# 且用户在网页把「聊天媒体」切到 COS 时，数据持久化不受影响。
_R2P_ACCOUNT_ID = _env_first("R2_PERSIST_ACCOUNT_ID", "R2_ACCOUNT_ID")
_R2P_ACCESS_KEY_ID = _env_first("R2_PERSIST_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID")
_R2P_SECRET_ACCESS_KEY = _env_first("R2_PERSIST_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY")
_R2P_BUCKET = _env_first("R2_PERSIST_BUCKET", "R2_BUCKET_NAME")
# 端点模板（可选）：支持 {bucket}/{account} 占位符；缺省虚拟主机风格
# https://{bucket}.{account}.r2.cloudflarestorage.com；EU 管辖区桶可填
# https://{bucket}.{account}.eu.r2.cloudflarestorage.com；自建 S3 兼容服务
# 可填 path-style，如 http://127.0.0.1:9000/{bucket}。
_R2P_ENDPOINT_TPL = _env_first("R2_PERSIST_ENDPOINT")
_R2P_REGION = _env_first("R2_PERSIST_REGION") or "auto"
_R2P_PREFIX = (_env_first("R2_PERSIST_PREFIX") or "lanplay/").strip()
if _R2P_PREFIX and not _R2P_PREFIX.endswith("/"):
    _R2P_PREFIX += "/"


def _r2_persist_configured() -> bool:
    return bool(_R2P_ACCOUNT_ID and _R2P_ACCESS_KEY_ID and _R2P_SECRET_ACCESS_KEY and _R2P_BUCKET)


# ---- 提供方选择：PERSIST_PROVIDER = auto（默认）/ blob / r2 ----
_PERSIST_PROVIDER = _env_first("PERSIST_PROVIDER", "PERSIST_BACKEND", default="auto").lower()
if _PERSIST_PROVIDER not in ("auto", "blob", "r2"):
    print(f"[适配器] PERSIST_PROVIDER={_PERSIST_PROVIDER!r} 无效，按 auto 处理", flush=True)
    _PERSIST_PROVIDER = "auto"


def _resolve_persist_provider() -> str:
    """返回实际生效的持久化提供方：'blob' / 'r2' / ''（无，退回 /tmp）。"""
    if _PERSIST_PROVIDER == "blob":
        return "blob" if _BLOB_TOKEN else ""
    if _PERSIST_PROVIDER == "r2":
        return "r2" if _r2_persist_configured() else ""
    # auto：兼容旧部署——先 Blob，再 R2，都没有则 /tmp
    if _BLOB_TOKEN:
        return "blob"
    if _r2_persist_configured():
        return "r2"
    return ""


_PERSIST_ACTIVE = _resolve_persist_provider()
if _PERSIST_PROVIDER in ("blob", "r2") and not _PERSIST_ACTIVE:
    print(
        f"[适配器] PERSIST_PROVIDER={_PERSIST_PROVIDER!r} 但凭据不全，退回 /tmp 文件模式",
        flush=True,
    )
# 远程持久化已启用（Blob 或 R2）；历史变量名保留，语义泛化
_persist_enabled = bool(_PERSIST_ACTIVE)
# 日志前缀按后端区分
_FS_TAG = {"blob": "[BlobFS]", "r2": "[R2FS]"}.get(_PERSIST_ACTIVE, "[VFS]")


def _parse_store_id_from_token(token: str) -> str:
    parts = (token or "").split("_")
    if len(parts) >= 4:
        return parts[3]
    return ""


_BLOB_STORE_ID = (
    (os.environ.get("BLOB_STORE_ID") or "").strip().removeprefix("store_")
    or _parse_store_id_from_token(_BLOB_TOKEN)
)

# 逻辑名 → 远端对象路径（Blob pathname / R2 object key）
_ACTIVE_PREFIX = _R2P_PREFIX if _PERSIST_ACTIVE == "r2" else _BLOB_PREFIX
_REMOTE_PATHNAMES: dict[str, str] = {
    "env": f"{_ACTIVE_PREFIX}env.json",
    "servers_manual": f"{_ACTIVE_PREFIX}servers_manual.json",
    "servers": f"{_ACTIVE_PREFIX}servers.json",
    "chinese_db": f"{_ACTIVE_PREFIX}chinese_db.json",
}

# 虚拟路径根（不存在于真实磁盘；仅作 main.py 的路径字符串）
_VFS_ROOT = "/__remotefs__"
_VFS_PATHS: dict[str, str] = {
    "env": f"{_VFS_ROOT}/env.json",
    "servers_manual": f"{_VFS_ROOT}/servers_manual.json",
    "servers": f"{_VFS_ROOT}/servers.json",
    "chinese_db": f"{_VFS_ROOT}/chinese_db.json",
}

# 未启用 Blob 时的 /tmp 回退路径
_TMP = os.environ.get("TMPDIR") or "/tmp"
_TMP_PATHS: dict[str, str] = {
    "env": os.path.join(_TMP, "env.json"),
    "servers_manual": os.path.join(_TMP, "servers_manual.json"),
    "servers": os.path.join(_TMP, "servers.json"),
    "chinese_db": os.path.join(_TMP, "chinese_db.json"),
}


def _active_paths() -> dict[str, str]:
    return _VFS_PATHS if _persist_enabled else _TMP_PATHS


def _apply_paths_to_app() -> None:
    paths = _active_paths()
    _app.ENV_CONFIG_FILE = paths["env"]
    _app.MANUAL_SERVERS_FILE = paths["servers_manual"]
    _app.SERVERS_FILE = paths["servers_manual"]
    _app.DEFAULT_SERVERS_FILE = paths["servers_manual"]
    _app.LOCAL_SERVERS_FILE = paths["servers"]
    _app.LOCAL_CHINESE_DB_FILE = paths["chinese_db"]


_apply_paths_to_app()


def _norm_path(p: str | os.PathLike[str] | Path | None) -> str:
    if p is None:
        return ""
    s = os.fspath(p)
    # 统一去掉多余斜杠；虚拟路径保持 posix
    if s.startswith(_VFS_ROOT):
        return str(PurePosixPath(s))
    try:
        return os.path.abspath(s)
    except Exception:
        return s


# path_str → key
def _path_to_key(path: str | os.PathLike[str] | Path | None) -> str | None:
    if path is None:
        return None
    try:
        s = os.fspath(path)
    except TypeError:
        return None
    n = _norm_path(s)
    # 精确匹配虚拟路径 / tmp 路径
    for key, vp in _VFS_PATHS.items():
        if n == vp or s == vp or n.rstrip("/") == vp.rstrip("/"):
            return key
    for key, tp in _TMP_PATHS.items():
        tp_n = _norm_path(tp)
        if n == tp_n or s == tp or s == tp_n:
            return key
    # basename 仅限 vfs/tmp 根下，避免误伤
    base = os.path.basename(n)
    mapping = {
        "env.json": "env",
        "servers_manual.json": "servers_manual",
        "servers.json": "servers",
        "chinese_db.json": "chinese_db",
    }
    if (
        n.startswith(_VFS_ROOT)
        or s.startswith(_VFS_ROOT)
        or n.startswith(_norm_path(_TMP) + os.sep)
        or n.startswith("/tmp/")
        or s.startswith("/tmp/")
    ):
        return mapping.get(base)
    return None


def _is_managed_path(path: str | os.PathLike[str] | Path | None) -> bool:
    return _path_to_key(path) is not None


def _is_managed_tmp_sidecar(path: str | os.PathLike[str] | Path | None) -> bool:
    """main._download_remote_file 会写 dest.<pid>.<hex>.tmp 再 os.replace。"""
    if path is None:
        return False
    s = os.fspath(path)
    n = _norm_path(s)
    if not (s.endswith(".tmp") or n.endswith(".tmp")):
        return False
    # dest_path 前缀匹配（原始串与规范化串都试）
    for vp in list(_VFS_PATHS.values()) + list(_TMP_PATHS.values()):
        for cand in (s, n, _norm_path(vp)):
            pass
        vp_n = _norm_path(vp)
        if n.startswith(vp_n + ".") or s.startswith(vp + ".") or s.startswith(vp_n + "."):
            return True
        # 也匹配 basename 以 managed 文件名开头的 tmp
        base_vp = os.path.basename(vp)
        if os.path.basename(n).startswith(base_vp + ".") and (
            n.startswith(_VFS_ROOT) or "/tmp/" in n or n.startswith(_norm_path(_TMP))
        ):
            return True
    return False


# ===========================================================================
# 内存存储
# ===========================================================================
_mem_lock = threading.RLock()
# key → bytes | None（None = 明确不存在）
_mem: dict[str, bytes | None] = {k: None for k in _REMOTE_PATHNAMES}
# key → 单调递增版本（充当 mtime_ns）
_mem_ver: dict[str, int] = {k: 0 for k in _REMOTE_PATHNAMES}
# download 临时缓冲：tmp_path → (target_key, bytes)
_mem_tmp: dict[str, tuple[str, bytes]] = {}
_ver_seq = 1


def _bump(key: str) -> int:
    global _ver_seq
    _ver_seq += 1
    _mem_ver[key] = _ver_seq
    return _ver_seq


def mem_get(key: str) -> bytes | None:
    with _mem_lock:
        data = _mem.get(key)
        return None if data is None else bytes(data)


def mem_set(key: str, data: bytes, *, push: bool = True) -> None:
    raw = bytes(data) if data is not None else b""
    with _mem_lock:
        _mem[key] = raw
        ver = _bump(key)
    print(f"{_FS_TAG} 内存已更新 key={key} size={len(raw)}B ver={ver} push={push}", flush=True)
    if push and _persist_enabled:
        try:
            ok = _remote_put(_REMOTE_PATHNAMES[key], raw)
            if ok:
                print(f"{_FS_TAG} 已同步远端 key={key} size={len(raw)}B path={_REMOTE_PATHNAMES[key]}", flush=True)
            else:
                print(f"{_FS_TAG} 同步远端失败 key={key}（内存已是新值；下次冷启动可能回潮）", flush=True)
        except Exception as exc:
            print(f"{_FS_TAG} 同步远端异常 key={key}: {exc!r}", flush=True)


def mem_force_push(key: str) -> bool:
    """把当前内存中的 key 强制 PUT 到远端存储（删除服务器后兜底同步）。"""
    if not _persist_enabled or key not in _REMOTE_PATHNAMES:
        return False
    data = mem_get(key)
    if data is None:
        # 不存在则推送空数组/空对象，避免远端残留旧自定义服务器
        if key in ("servers_manual", "servers"):
            data = b"[]\n"
        elif key == "env":
            data = b"{}\n"
        else:
            data = b"{}\n"
        with _mem_lock:
            _mem[key] = data
            _bump(key)
    try:
        ok = _remote_put(_REMOTE_PATHNAMES[key], data)
        print(
            f"{_FS_TAG} force_push key={key} ok={ok} size={len(data)}B path={_REMOTE_PATHNAMES[key]}",
            flush=True,
        )
        return bool(ok)
    except Exception as exc:
        print(f"{_FS_TAG} force_push 异常 key={key}: {exc!r}", flush=True)
        return False


# 多实例一致性：其它实例写了远端存储后，本实例内存可能仍是旧值。
# 按 TTL 从远端重新拉取关键 key（尤其 servers_manual / env）。
_revalidate_lock = threading.RLock()
_revalidate_at: dict[str, float] = {}
_REVALIDATE_TTL = float(
    _env_first("PERSIST_REVALIDATE_TTL", "BLOB_REVALIDATE_TTL", default="3") or 3
)


def persist_revalidate_key(key: str, *, force: bool = False) -> bool:
    """若远端存储上内容更新，覆盖本实例内存。返回是否发生了变更。"""
    if not _persist_enabled or key not in _REMOTE_PATHNAMES:
        return False
    now = time.time()
    with _revalidate_lock:
        last = _revalidate_at.get(key, 0.0)
        if not force and (now - last) < _REVALIDATE_TTL:
            return False
        _revalidate_at[key] = now
    try:
        remote = _remote_get(_REMOTE_PATHNAMES[key])
    except Exception as exc:
        print(f"{_FS_TAG} revalidate GET 失败 key={key}: {exc!r}", flush=True)
        return False
    if remote is None:
        # 远端无对象：若本地是用户配置，保留本地；servers_manual 空对象视为 []
        return False
    if not _validate_payload(key, remote):
        print(f"{_FS_TAG} revalidate 校验失败 key={key}", flush=True)
        return False
    local = mem_get(key)
    if local is not None and local == remote:
        return False
    # 不 push 回远端，只更新内存
    with _mem_lock:
        _mem[key] = bytes(remote)
        ver = _bump(key)
    print(
        f"{_FS_TAG} revalidate 已用远端覆盖内存 key={key} size={len(remote)}B ver={ver}",
        flush=True,
    )
    # 配置签名变化后强制 refresh
    try:
        if key in ("servers_manual", "servers", "chinese_db"):
            _app.ctx.refresh_config(force=True)
        if key == "env":
            _app.apply_r2_config_to_runtime(_app.load_env_config())
    except Exception as exc:
        print(f"{_FS_TAG} revalidate 后 refresh 失败: {exc!r}", flush=True)
    return True


def persist_revalidate_user_config(*, force: bool = False) -> None:
    """读路径前刷新用户相关配置（自定义服务器 + env）。"""
    if not _persist_enabled:
        return
    persist_revalidate_key("servers_manual", force=force)
    persist_revalidate_key("env", force=force)



def mem_exists(key: str) -> bool:
    with _mem_lock:
        return _mem.get(key) is not None


def _mem_stat(key: str) -> os.stat_result | None:
    with _mem_lock:
        data = _mem.get(key)
        if data is None:
            return None
        ver = int(_mem_ver.get(key, 1))
        size = len(data)
    st = os.stat_result((0o100644, abs(hash(key)) % (10**8), 0, 1, 0, 0, size, ver, ver, ver))
    # 尽量提供 st_mtime_ns（AppContext._config_signature 使用）
    try:
        # 不可变，重新用更多字段不可靠；monkeypatch signature 侧用 size+ver 即可
        object.__setattr__(st, "st_mtime_ns", ver)
    except Exception:
        pass
    return st


# ===========================================================================
# Blob HTTP
# ===========================================================================
def _blob_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    h = {
        "authorization": f"Bearer {_BLOB_TOKEN}",
        "x-api-version": _BLOB_API_VERSION,
        "user-agent": "lanplay-monitor-vercel-adapter/2.0-blobfs",
    }
    if _BLOB_STORE_ID:
        h["x-vercel-blob-store-id"] = _BLOB_STORE_ID
    if extra:
        h.update(extra)
    return h


def _blob_request(
    method: str,
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return int(resp.status), resp.read()
    except urllib.error.HTTPError as e:
        try:
            body = e.read() or b""
        except Exception:
            body = b""
        return int(e.code), body
    except Exception as exc:
        print(f"[Blob] 请求异常 {method} {url}: {exc!r}", flush=True)
        return 0, str(exc).encode("utf-8", errors="replace")


def _blob_cdn_url(pathname: str, access: str | None = None) -> str:
    acc = access or _blob_effective_access
    sid = _BLOB_STORE_ID or "unknown"
    pn = pathname.lstrip("/")
    enc = "/".join(urllib.parse.quote(seg, safe="") for seg in pn.split("/"))
    return f"https://{sid}.{acc}.blob.vercel-storage.com/{enc}"


def _blob_put(pathname: str, content: bytes, content_type: str = "application/json; charset=utf-8") -> bool:
    global _blob_effective_access
    if not _persist_enabled:
        return False
    qs = urllib.parse.urlencode({"pathname": pathname})
    url = f"{_BLOB_API}/?{qs}"

    def _do(access: str) -> tuple[int, bytes]:
        headers = _blob_headers(
            {
                "x-vercel-blob-access": access,
                "x-content-type": content_type,
                "x-add-random-suffix": "0",
                "x-allow-overwrite": "1",
                "x-cache-control-max-age": "60",
            }
        )
        return _blob_request("PUT", url, data=content, headers=headers, timeout=45.0)

    status, body = _do(_blob_effective_access)
    if status != 200:
        msg = body.decode("utf-8", errors="replace")
        alt = "public" if _blob_effective_access == "private" else "private"
        if "access" in msg.lower() or "private store" in msg.lower() or "public store" in msg.lower():
            print(f"[Blob] PUT access={_blob_effective_access} 失败，尝试 {alt}…", flush=True)
            status2, body2 = _do(alt)
            if status2 == 200:
                _blob_effective_access = alt
                status, body = status2, body2
            else:
                print(f"[Blob] PUT 失败 pathname={pathname} status={status} body={body[:300]!r}", flush=True)
                return False
        else:
            print(f"[Blob] PUT 失败 pathname={pathname} status={status} body={body[:300]!r}", flush=True)
            return False
    print(
        f"[Blob] PUT 成功 pathname={pathname} size={len(content)}B access={_blob_effective_access}",
        flush=True,
    )
    return True


def _blob_get(pathname: str) -> bytes | None:
    if not _persist_enabled:
        return None
    if _BLOB_STORE_ID:
        for acc in (_blob_effective_access, "private", "public"):
            cdn = _blob_cdn_url(pathname, acc)
            fetch_url = cdn + ("&" if "?" in cdn else "?") + "cache=0"
            status, body = _blob_request("GET", fetch_url, headers=_blob_headers(), timeout=45.0)
            if status == 200 and body is not None:
                return body
            if status == 404:
                return None
    # list 兜底
    qs = urllib.parse.urlencode({"prefix": _BLOB_PREFIX, "limit": "100"})
    status, body = _blob_request("GET", f"{_BLOB_API}?{qs}", headers=_blob_headers(), timeout=20.0)
    if status != 200:
        return None
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:
        return None
    for b in data.get("blobs") or []:
        if not isinstance(b, dict):
            continue
        if str(b.get("pathname") or "") == pathname:
            u = str(b.get("url") or "").strip()
            if not u:
                continue
            st2, body2 = _blob_request(
                "GET",
                u + ("&" if "?" in u else "?") + "cache=0",
                headers=_blob_headers(),
                timeout=45.0,
            )
            if st2 == 200:
                return body2
    return None


# ===========================================================================
# Cloudflare R2 后端（S3 兼容 API + AWS Signature V4，零第三方依赖）
# ===========================================================================
class _CloudflareR2Backend:
    """数据持久化 R2 后端。

    签名实现独立于 main.py 的聊天媒体存储（后者读运行时全局变量，
    可能被 env.json 切到 COS）；持久化凭据固定来自 OS 环境变量。
    """

    label = "R2"

    def __init__(
        self,
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        endpoint_tpl: str = "",
        region: str = "auto",
    ) -> None:
        self._access_key = access_key_id
        self._secret = secret_access_key
        self._region = region or "auto"
        tpl = (endpoint_tpl or "").strip() or "https://{bucket}.{account}.r2.cloudflarestorage.com"
        if "://" not in tpl:
            tpl = "https://" + tpl
        # 端点模板支持 {bucket}/{account} 占位符；base 形如
        # https://<bucket>.<account>.r2.cloudflarestorage.com（虚拟主机风格）
        # 或 http://host:9000/<bucket>（path-style，自建 S3 兼容服务）
        self._base = tpl.format(bucket=bucket, account=account_id).rstrip("/")
        self._host = urllib.parse.urlparse(self._base).netloc
        # path-style 端点的 base 含 /<bucket> 前缀，必须一并纳入签名 CanonicalURI
        self._uri_prefix = urllib.parse.urlparse(self._base).path.rstrip("/")

    # ---- AWS Signature V4（service=s3）----
    def _authorize(
        self, method: str, uri: str, headers: dict[str, str], payload: bytes
    ) -> tuple[str, str]:
        now = _dt_cls.now(_dt_tz.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        hm = {k.lower(): str(v).strip() for k, v in headers.items()}
        hm["x-amz-date"] = amz_date
        names = sorted(hm)
        signed_headers = ";".join(names)
        canonical_headers = "".join(f"{k}:{hm[k]}\n" for k in names)
        payload_hash = hashlib.sha256(payload).hexdigest()
        canonical_request = "\n".join((method, uri, "", canonical_headers, signed_headers, payload_hash))
        scope = f"{date_stamp}/{self._region}/s3/aws4_request"
        string_to_sign = "\n".join(
            (
                "AWS4-HMAC-SHA256",
                amz_date,
                scope,
                hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
            )
        )

        def _h(key: bytes, msg: str) -> bytes:
            return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

        k = _h(("AWS4" + self._secret).encode("utf-8"), date_stamp)
        k = _h(k, self._region)
        k = _h(k, "s3")
        k = _h(k, "aws4_request")
        signature = hmac.new(k, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        auth = (
            f"AWS4-HMAC-SHA256 Credential={self._access_key}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        return auth, amz_date

    def _request(
        self,
        method: str,
        key: str,
        *,
        payload: bytes = b"",
        content_type: str = "application/json; charset=utf-8",
        timeout: float = 30.0,
    ) -> tuple[int, bytes, str]:
        """返回 (status, body, etag)；网络异常时 status=0。"""
        # 签名用 CanonicalURI（path-style 端点须含 base 自带的 /<bucket> 前缀）；
        # 请求 URL 则直接拼 base（base 已含该前缀，勿重复）。
        quoted = urllib.parse.quote(key.lstrip("/"), safe="/")
        uri = f"{self._uri_prefix}/{quoted}"
        url = f"{self._base}/{quoted}"
        headers: dict[str, str] = {
            "Host": self._host,
            "x-amz-content-sha256": hashlib.sha256(payload).hexdigest(),
        }
        if method == "PUT":
            headers["Content-Type"] = content_type
            headers["Content-Length"] = str(len(payload))
        auth, amz_date = self._authorize(method, uri, headers, payload)
        headers["Authorization"] = auth
        headers["x-amz-date"] = amz_date
        req = urllib.request.Request(
            url,
            data=payload if method == "PUT" else None,
            method=method,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                return int(resp.status), body, str(resp.headers.get("ETag", "") or "")
        except urllib.error.HTTPError as e:
            try:
                body = e.read() or b""
            except Exception:
                body = b""
            return int(e.code), body, ""
        except Exception as exc:
            print(f"{_FS_TAG} {method} 请求异常 key={key}: {exc!r}", flush=True)
            return 0, str(exc).encode("utf-8", errors="replace"), ""

    # ---- 后端统一接口 ----
    def get(self, pathname: str) -> bytes | None:
        key = pathname.lstrip("/")
        status, body, _etag = self._request("GET", key, timeout=30.0)
        if status == 200:
            return body
        if status == 404:
            return None
        if status in (401, 403):
            print(
                f"{_FS_TAG} GET 鉴权失败（检查 R2_PERSIST_ACCESS_KEY_ID / "
                f"R2_PERSIST_SECRET_ACCESS_KEY 及 Token 的对象读写权限）key={key}",
                flush=True,
            )
            return None
        print(f"{_FS_TAG} GET 失败 key={key} status={status} body={body[:200]!r}", flush=True)
        return None

    def put(self, pathname: str, content: bytes, content_type: str = "application/json; charset=utf-8") -> bool:
        key = pathname.lstrip("/")
        status, body, etag = self._request("PUT", key, payload=content, content_type=content_type, timeout=45.0)
        if 200 <= status < 300:
            tag = etag.strip().strip('"')[:16]
            print(f"{_FS_TAG} PUT 成功 key={key} size={len(content)}B etag={tag}", flush=True)
            return True
        if status in (401, 403):
            print(f"{_FS_TAG} PUT 鉴权失败（检查 R2 Token 的 Object Read & Write 权限）key={key}", flush=True)
            return False
        print(f"{_FS_TAG} PUT 失败 key={key} status={status} body={body[:200]!r}", flush=True)
        return False


class _VercelBlobBackend:
    """Blob 薄包装：沿用上方 Blob REST 实现，接口与 R2 后端一致。"""

    label = "Blob"

    def get(self, pathname: str) -> bytes | None:
        return _blob_get(pathname)

    def put(self, pathname: str, content: bytes, content_type: str = "application/json; charset=utf-8") -> bool:
        return _blob_put(pathname, content, content_type)


# 实例化生效后端 + 统一读写入口（VFS 层只认这两个函数）
_BACKEND = None
if _PERSIST_ACTIVE == "r2":
    _BACKEND = _CloudflareR2Backend(
        account_id=_R2P_ACCOUNT_ID,
        access_key_id=_R2P_ACCESS_KEY_ID,
        secret_access_key=_R2P_SECRET_ACCESS_KEY,
        bucket=_R2P_BUCKET,
        endpoint_tpl=_R2P_ENDPOINT_TPL,
        region=_R2P_REGION,
    )
elif _PERSIST_ACTIVE == "blob":
    _BACKEND = _VercelBlobBackend()


def _remote_get(pathname: str) -> bytes | None:
    return _BACKEND.get(pathname) if _BACKEND is not None else None


def _remote_put(pathname: str, content: bytes) -> bool:
    return _BACKEND.put(pathname, content) if _BACKEND is not None else False


def _validate_payload(key: str, data: bytes) -> bool:
    try:
        parsed = json.loads(data.decode("utf-8-sig"))
    except Exception as exc:
        print(f"{_FS_TAG} {key} 不是合法 JSON: {exc!r}", flush=True)
        return False
    if key == "env" and not isinstance(parsed, dict):
        return False
    if key in ("servers_manual", "servers"):
        if isinstance(parsed, dict) and isinstance(parsed.get("servers"), list):
            return True
        return isinstance(parsed, list)
    if key == "chinese_db":
        return isinstance(parsed, (dict, list))
    return True


def persist_hydrate_memory() -> dict[str, bool]:
    """冷启动：远端存储 → 内存；缺失则用部署包。"""
    results: dict[str, bool] = {}
    if not _persist_enabled:
        print("[适配器] 未配置持久化凭据（BLOB_READ_WRITE_TOKEN 或 R2_PERSIST_* / R2_*），使用 /tmp 文件模式", flush=True)
        return results
    if _PERSIST_ACTIVE == "blob":
        print(
            f"{_FS_TAG} 内存直连模式 provider=blob api={_BLOB_API} access={_BLOB_ACCESS} "
            f"store={_BLOB_STORE_ID or '?'} prefix={_BLOB_PREFIX!r} version={_BLOB_API_VERSION}",
            flush=True,
        )
    else:
        print(
            f"{_FS_TAG} 内存直连模式 provider=r2 endpoint={_BACKEND._base if _BACKEND else '?'} "
            f"bucket={_R2P_BUCKET} prefix={_R2P_PREFIX!r} region={_R2P_REGION}",
            flush=True,
        )
    deploy_names = {
        "env": "env.json",
        "servers_manual": None,  # 仓库通常没有
        "servers": "servers.json",
        "chinese_db": "chinese_db.json",
    }
    for key, pathname in _REMOTE_PATHNAMES.items():
        data = None
        try:
            data = _remote_get(pathname)
        except Exception as exc:
            print(f"{_FS_TAG} pull {key} 异常: {exc!r}", flush=True)
        if data and _validate_payload(key, data):
            with _mem_lock:
                _mem[key] = data
                _bump(key)
            print(f"{_FS_TAG} 从远端载入 {key} size={len(data)}B", flush=True)
            results[key] = True
            continue
        # 部署包兜底
        dep = deploy_names.get(key)
        if dep:
            src = ROOT / dep
            if src.is_file():
                try:
                    raw = src.read_bytes()
                    if _validate_payload(key, raw):
                        with _mem_lock:
                            _mem[key] = raw
                            _bump(key)
                        print(f"{_FS_TAG} 部署包兜底 {key} size={len(raw)}B", flush=True)
                        results[key] = False
                        # R2：远端缺失时回填部署包内容，首个实例负责播种，
                        # 后续实例即可直接从 R2 hydrate（幂等，内容相同）。
                        if _PERSIST_ACTIVE == "r2":
                            try:
                                if _remote_put(pathname, raw):
                                    print(f"{_FS_TAG} 远端缺失，已回填 {key} size={len(raw)}B", flush=True)
                            except Exception as exc:
                                print(f"{_FS_TAG} 回填 {key} 异常: {exc!r}", flush=True)
                        continue
                except Exception as exc:
                    print(f"{_FS_TAG} 部署包读取失败 {key}: {exc!r}", flush=True)
        print(f"{_FS_TAG} {key} 远端与部署包均无数据", flush=True)
        results[key] = False
    return results


# ===========================================================================
# 未启用 Blob：/tmp 回退（复制部署包）
# ===========================================================================
if not _persist_enabled:
    for _name, _key in (
        ("servers.json", "servers"),
        ("chinese_db.json", "chinese_db"),
        ("env.json", "env"),
    ):
        _src = ROOT / _name
        _dst = _TMP_PATHS[_key]
        try:
            if _src.is_file() and not os.path.isfile(_dst):
                shutil.copy(_src, _dst)
                print(f"[适配器] 已复制 {_name} → {_dst}", flush=True)
        except Exception as exc:
            print(f"[适配器] 复制 {_name} 失败: {exc!r}", flush=True)


# ===========================================================================
# Monkey-patch：让 main.py 的 Path/open/os 走内存（仅 managed 路径）
# ===========================================================================
_orig_open = builtins.open
_orig_os_stat = os.stat
_orig_os_replace = os.replace
_orig_os_remove = os.remove
_orig_os_path_isfile = os.path.isfile
_orig_os_path_exists = os.path.exists
_orig_os_path_getsize = os.path.getsize
_orig_path_is_file = Path.is_file
_orig_path_exists = Path.exists
_orig_path_stat = Path.stat
_orig_path_read_text = Path.read_text
_orig_path_write_text = Path.write_text
_orig_path_read_bytes = Path.read_bytes
_orig_path_write_bytes = Path.write_bytes


def _tmp_path_to_key(tmp_path: str) -> str | None:
    """从 dest.<pid>.<hex>.tmp 反推 managed key。"""
    s = os.fspath(tmp_path)
    n = _norm_path(s)
    for key, vp in _VFS_PATHS.items():
        for prefix in (vp + ".", _norm_path(vp) + ".", os.path.basename(vp) + "."):
            if s.startswith(prefix) or n.startswith(prefix) or os.path.basename(n).startswith(os.path.basename(vp) + "."):
                if key and (s.startswith(_VFS_ROOT) or n.startswith(_VFS_ROOT) or os.path.basename(n).startswith(os.path.basename(vp))):
                    # basename 规则：servers.json.xxx.tmp
                    bn = os.path.basename(n)
                    if bn.startswith(os.path.basename(vp) + ".") and bn.endswith(".tmp"):
                        return key
        if n.startswith(_norm_path(vp) + ".") or s.startswith(vp + "."):
            return key
    for key, vp in _TMP_PATHS.items():
        if n.startswith(_norm_path(vp) + ".") or s.startswith(vp + "."):
            return key
    # basename only
    bn = os.path.basename(n)
    for key, vp in _VFS_PATHS.items():
        if bn.startswith(os.path.basename(vp) + ".") and bn.endswith(".tmp"):
            return key
    return None


class _MemTextIO(io.StringIO):

    def __init__(self, key: str, initial: str, write_mode: bool):
        super().__init__(initial)
        self._key = key
        self._write_mode = write_mode
        if write_mode:
            self.seek(0)
            self.truncate(0)

    def close(self) -> None:
        if self._write_mode and not self.closed:
            try:
                data = self.getvalue().encode("utf-8")
                mem_set(self._key, data, push=True)
            except Exception as exc:
                print(f"{_FS_TAG} TextIO close 写回失败 {self._key}: {exc!r}", flush=True)
        super().close()


class _MemBinaryIO(io.BytesIO):
    def __init__(self, key: str | None, initial: bytes, write_mode: bool, tmp_path: str | None = None):
        super().__init__(initial)
        self._key = key
        self._write_mode = write_mode
        self._tmp_path = tmp_path
        if write_mode:
            self.seek(0)
            self.truncate(0)

    def close(self) -> None:
        if self._write_mode and not self.closed:
            data = self.getvalue()
            try:
                if self._tmp_path is not None:
                    target = _tmp_path_to_key(self._tmp_path)
                    if target is None and self._key:
                        target = self._key
                    if target:
                        with _mem_lock:
                            # 同时用原始与规范化键存，避免 replace 路径不一致
                            payload = (target, bytes(data))
                            _mem_tmp[self._tmp_path] = payload
                            _mem_tmp[_norm_path(self._tmp_path)] = payload
                    else:
                        print(f"{_FS_TAG} 未知 tmp 写路径 {self._tmp_path}", flush=True)
                elif self._key:
                    mem_set(self._key, data, push=True)
            except Exception as exc:
                print(f"{_FS_TAG} BinaryIO close 失败: {exc!r}", flush=True)
        super().close()


def _open_patch(file, mode="r", *args, **kwargs):
    path_s = os.fspath(file) if not isinstance(file, int) else None
    if path_s is None:
        return _orig_open(file, mode, *args, **kwargs)

    key = _path_to_key(path_s)
    is_tmp = _is_managed_tmp_sidecar(path_s)
    if key is None and not is_tmp:
        return _orig_open(file, mode, *args, **kwargs)

    # Blob 未启用时 managed 路径是真实 /tmp 文件
    if not _persist_enabled and not str(path_s).startswith(_VFS_ROOT):
        return _orig_open(file, mode, *args, **kwargs)

    writing = any(c in mode for c in "wax+")
    reading = "r" in mode or not writing
    binary = "b" in mode

    if is_tmp and writing:
        return _MemBinaryIO(None, b"", True, tmp_path=_norm_path(path_s))

    if key is None:
        return _orig_open(file, mode, *args, **kwargs)

    raw = mem_get(key) or b""
    if reading and not writing:
        if not mem_exists(key):
            raise FileNotFoundError(2, "No such file or directory", path_s)
        if binary:
            return _MemBinaryIO(key, raw, False)
        enc = kwargs.get("encoding") or "utf-8"
        # utf-8-sig
        text = raw.decode(enc.replace("-sig", "") if enc else "utf-8")
        if enc and "sig" in enc and text.startswith("\ufeff"):
            text = text.lstrip("\ufeff")
        # 简易：统一 decode
        try:
            text = raw.decode("utf-8-sig")
        except Exception:
            text = raw.decode("utf-8", errors="replace")
        return io.StringIO(text)

    if writing:
        if binary:
            return _MemBinaryIO(key, b"", True)
        return _MemTextIO(key, "", True)

    return _orig_open(file, mode, *args, **kwargs)


def _os_stat_patch(path, *args, **kwargs):
    if _persist_enabled:
        key = _path_to_key(path)
        if key is not None:
            st = _mem_stat(key)
            if st is None:
                raise FileNotFoundError(2, "No such file or directory", os.fspath(path))
            return st
    return _orig_os_stat(path, *args, **kwargs)


def _os_path_isfile_patch(path):
    if _persist_enabled:
        key = _path_to_key(path)
        if key is not None:
            return mem_exists(key)
        if _is_managed_tmp_sidecar(path):
            return _norm_path(path) in _mem_tmp
    return _orig_os_path_isfile(path)


def _os_path_exists_patch(path):
    if _persist_enabled:
        key = _path_to_key(path)
        if key is not None:
            return mem_exists(key)
        if _is_managed_tmp_sidecar(path):
            return _norm_path(path) in _mem_tmp
    return _orig_os_path_exists(path)


def _os_path_getsize_patch(path):
    if _persist_enabled:
        key = _path_to_key(path)
        if key is not None:
            data = mem_get(key)
            if data is None:
                raise FileNotFoundError(2, "No such file or directory", os.fspath(path))
            return len(data)
    return _orig_os_path_getsize(path)


def _os_replace_patch(src, dst):
    if _persist_enabled:
        src_s = os.fspath(src)
        src_n = _norm_path(src_s)
        dst_key = _path_to_key(dst)
        # download: tmp → dest
        hit = None
        with _mem_lock:
            if src_n in _mem_tmp:
                hit = _mem_tmp.pop(src_n)
                _mem_tmp.pop(src_s, None)
            elif src_s in _mem_tmp:
                hit = _mem_tmp.pop(src_s)
                _mem_tmp.pop(src_n, None)
        if hit is not None and dst_key is not None:
            _tkey, data = hit
            key = dst_key or _tkey
            mem_set(key, data, push=True)
            print(f"{_FS_TAG} os.replace 提交下载结果 → {key} size={len(data)}B", flush=True)
            return
        if hit is not None and dst_key is None:
            # dst 无法识别时仍写入反推 key
            _tkey, data = hit
            mem_set(_tkey, data, push=True)
            return
        # 两者都是 managed
        sk, dk = _path_to_key(src), _path_to_key(dst)
        if sk is not None and dk is not None:
            data = mem_get(sk)
            if data is None:
                raise FileNotFoundError(2, "No such file or directory", os.fspath(src))
            mem_set(dk, data, push=True)
            with _mem_lock:
                _mem[sk] = None
                _bump(sk)
            return
        # tmp sidecar 但未入 _mem_tmp（空写？）
        if _is_managed_tmp_sidecar(src) and dst_key is not None:
            print(f"{_FS_TAG} os.replace 跳过空 tmp {src_s}", flush=True)
            return
    return _orig_os_replace(src, dst)


def _os_remove_patch(path):
    if _persist_enabled:
        n = _norm_path(path)
        if n in _mem_tmp:
            _mem_tmp.pop(n, None)
            return
        key = _path_to_key(path)
        if key is not None:
            with _mem_lock:
                _mem[key] = None
                _bump(key)
            return
    return _orig_os_remove(path)


def _path_is_file_patch(self: Path) -> bool:
    if _persist_enabled and _path_to_key(self) is not None:
        return mem_exists(_path_to_key(self))  # type: ignore[arg-type]
    return _orig_path_is_file(self)


def _path_exists_patch(self: Path) -> bool:
    if _persist_enabled and _path_to_key(self) is not None:
        return mem_exists(_path_to_key(self))  # type: ignore[arg-type]
    return _orig_path_exists(self)


def _path_stat_patch(self: Path, *args, **kwargs):
    if _persist_enabled:
        key = _path_to_key(self)
        if key is not None:
            st = _mem_stat(key)
            if st is None:
                raise FileNotFoundError(2, "No such file or directory", str(self))
            return st
    return _orig_path_stat(self, *args, **kwargs)


def _path_read_text_patch(self: Path, encoding: str | None = "utf-8", errors: str | None = None) -> str:
    if _persist_enabled:
        key = _path_to_key(self)
        if key is not None:
            data = mem_get(key)
            if data is None:
                raise FileNotFoundError(2, "No such file or directory", str(self))
            enc = encoding or "utf-8"
            if errors:
                return data.decode(enc.replace("-sig", "") if "sig" in (enc or "") else enc, errors=errors)
            try:
                return data.decode("utf-8-sig" if "sig" in (enc or "") else enc)
            except Exception:
                return data.decode("utf-8", errors="replace")
    return _orig_path_read_text(self, encoding=encoding, errors=errors)  # type: ignore[arg-type]


def _path_write_text_patch(self: Path, data: str, encoding: str | None = "utf-8", errors: str | None = None, newline: str | None = None) -> int:
    if _persist_enabled:
        key = _path_to_key(self)
        if key is not None:
            enc = encoding or "utf-8"
            raw = data.encode(enc.replace("-sig", ""), errors=errors or "strict")
            mem_set(key, raw, push=True)
            return len(raw)
    return _orig_path_write_text(self, data, encoding=encoding, errors=errors, newline=newline)  # type: ignore[call-arg]


def _path_read_bytes_patch(self: Path) -> bytes:
    if _persist_enabled:
        key = _path_to_key(self)
        if key is not None:
            data = mem_get(key)
            if data is None:
                raise FileNotFoundError(2, "No such file or directory", str(self))
            return data
    return _orig_path_read_bytes(self)


def _path_write_bytes_patch(self: Path, data: bytes) -> int:
    if _persist_enabled:
        key = _path_to_key(self)
        if key is not None:
            mem_set(key, bytes(data), push=True)
            return len(data)
    return _orig_path_write_bytes(self, data)


def _path_open_patch(self: Path, mode: str = "r", *args, **kwargs):
    """Path.open → 走同一套 VFS open，避免 pathlib 内部绕过 builtins.open。"""
    return _open_patch(self, mode, *args, **kwargs)


def _install_vfs_patches() -> None:
    if not _persist_enabled:
        print(f"{_FS_TAG} 跳过 VFS patch（未启用远程持久化，使用真实 /tmp）", flush=True)
        return
    builtins.open = _open_patch  # type: ignore[assignment]
    # pathlib / 部分库用 io.open，必须一起补丁
    io.open = _open_patch  # type: ignore[assignment]
    os.stat = _os_stat_patch  # type: ignore[assignment]
    os.replace = _os_replace_patch  # type: ignore[assignment]
    os.remove = _os_remove_patch  # type: ignore[assignment]
    os.unlink = _os_remove_patch  # type: ignore[assignment]
    os.path.isfile = _os_path_isfile_patch  # type: ignore[assignment]
    os.path.exists = _os_path_exists_patch  # type: ignore[assignment]
    os.path.getsize = _os_path_getsize_patch  # type: ignore[assignment]
    Path.is_file = _path_is_file_patch  # type: ignore[method-assign, assignment]
    Path.exists = _path_exists_patch  # type: ignore[method-assign, assignment]
    Path.stat = _path_stat_patch  # type: ignore[method-assign, assignment]
    Path.read_text = _path_read_text_patch  # type: ignore[method-assign, assignment]
    Path.write_text = _path_write_text_patch  # type: ignore[method-assign, assignment]
    Path.read_bytes = _path_read_bytes_patch  # type: ignore[method-assign, assignment]
    Path.write_bytes = _path_write_bytes_patch  # type: ignore[method-assign, assignment]
    Path.open = _path_open_patch  # type: ignore[method-assign, assignment]
    print(f"{_FS_TAG} 已安装内存虚拟文件系统 patch（直连 {_PERSIST_ACTIVE}，不写 /tmp）", flush=True)


_install_vfs_patches()

# AppContext 签名在 blob 模式下用内存版本
if _persist_enabled:
    def _config_signature_blob_clean() -> tuple:
        order = ("servers", "servers_manual", "servers_manual", "chinese_db")
        sig: list[Any] = []
        for k in order:
            with _mem_lock:
                data = _mem.get(k)
                ver = _mem_ver.get(k, 0)
            sig.append(None if data is None else (ver, len(data)))
        return tuple(sig)

    _app.AppContext._config_signature = staticmethod(_config_signature_blob_clean)  # type: ignore[assignment]

# reload_r2_config_if_changed 依赖 mtime；内存模式下用 ver
if _persist_enabled:
    _orig_reload = _app.reload_r2_config_if_changed

    def _reload_r2_blob() -> None:
        global _env_applied_ver
        with _mem_lock:
            ver = _mem_ver.get("env", 0)
            has = _mem.get("env") is not None
        if has and ver == getattr(_reload_r2_blob, "_ver", None):
            return
        cfg = _app.load_env_config()
        _app.apply_r2_config_to_runtime(cfg)
        _reload_r2_blob._ver = ver  # type: ignore[attr-defined]

    _reload_r2_blob._ver = None  # type: ignore[attr-defined]
    _app.reload_r2_config_if_changed = _reload_r2_blob  # type: ignore[assignment]


# ===========================================================================
# 冷启动
# ===========================================================================
_persist_pull_results = persist_hydrate_memory() if _persist_enabled else {}

try:
    _app.apply_r2_config_to_runtime(_app.load_env_config())
    print("[适配器] env 配置已应用到运行时全局", flush=True)
except Exception as exc:
    print(f"[适配器] apply_r2_config_to_runtime 失败: {exc!r}", flush=True)


# 远程下载改为纯内存：不经 dest.*.tmp 落盘，校验 JSON 后 mem_set(+Blob)
_orig_download_remote_file = _app._download_remote_file


def _download_remote_file_mem(url: str, dest_path: str) -> str:
    """Vercel 远程持久化模式下下载，返回 updated / skipped / failed。

    与 main.py 的哈希校验语义保持一致：远程 JSON 拉取并校验后，计算
    SHA-256 与当前内存/Blob 内容比较。哈希一致时不调用 mem_set，避免
    重复 PUT Blob、内存版本递增和无意义的配置重载。
    """
    key = _path_to_key(dest_path)
    if not (_persist_enabled and key is not None):
        result = _orig_download_remote_file(url, dest_path)
        # 兼容旧版 main.py 的 bool 返回值，同时优先透传新版状态字符串。
        if result is True:
            return "updated"
        if result is False or result is None:
            return "failed"
        return str(result)

    local_data = mem_get(key)
    local_hash = hashlib.sha256(local_data).hexdigest() if local_data is not None else None

    # 复用 main 的候选 URL / SSL。
    try:
        candidates = _app._remote_candidate_urls(url)
    except Exception:
        candidates = [url]
    last_err = None
    for cand_url in candidates:
        try:
            req = urllib.request.Request(
                cand_url,
                headers={
                    "User-Agent": f"{_app.APP_NAME}/1.0",
                    "Accept": "application/json",
                    "Cache-Control": "no-cache",
                },
            )
            ctx_ssl = getattr(_app, "SSL_CTX", None)
            with urllib.request.urlopen(req, timeout=15, context=ctx_ssl) as resp:
                data = resp.read()
            # 写入远端存储前先校验 JSON，再计算远程内容哈希。
            json.loads(data.decode("utf-8-sig"))
            remote_hash = hashlib.sha256(data).hexdigest()

            if local_hash == remote_hash:
                print(
                    f"{_FS_TAG} 远程哈希一致，跳过写入 key={key} "
                    f"sha256={remote_hash[:12]}",
                    flush=True,
                )
                return "skipped"

            mem_set(key, data, push=True)
            if cand_url != url:
                print(f"[远程下载] 经代理成功 {cand_url}", flush=True)
            print(
                f"{_FS_TAG} 远程内容已更新 key={key} size={len(data)}B "
                f"{local_hash[:12] if local_hash else 'none'} -> {remote_hash[:12]}",
                flush=True,
            )
            return "updated"
        except Exception as exc:
            last_err = exc
            print(f"[远程下载] 下载失败 {cand_url} -> blobfs:{key}: {exc}", flush=True)
            continue
    if last_err:
        print(f"{_FS_TAG} 远程下载全部失败 key={key}: {last_err!r}", flush=True)
    return "failed"


_app._download_remote_file = _download_remote_file_mem  # type: ignore[assignment]


def _cold_fetch(url: str, dest: str, label: str, status_key: str) -> str:
    print(f"[适配器] 冷启动拉取{label} url={url} -> {dest}", flush=True)
    try:
        result = _app._download_remote_file(url, dest)
        # 兼容旧版 bool 返回，防止 False 被误判为成功。
        if result is True:
            result = "updated"
        elif result is False or result is None:
            result = "failed"
        else:
            result = str(result)
    except Exception as exc:
        print(f"[适配器] 冷启动{label}异常: {exc!r}", flush=True)
        traceback.print_exc()
        result = "failed"

    key = _path_to_key(dest)
    if result != "failed":
        size = -1
        if key and mem_exists(key):
            size = len(mem_get(key) or b"")
        elif os.path.isfile(dest):
            try:
                size = os.path.getsize(dest)
            except Exception:
                pass
        action = "内容已更新" if result == "updated" else "哈希一致，已跳过写入"
        print(f"[适配器] 冷启动{label}成功：{action} size={size}B", flush=True)
        try:
            with _app._download_status_lock:
                st = _app._download_status
                if status_key == "servers":
                    st["servers_last_success"] = time.time()
                    st["servers_last_error"] = ""
                    st["remote_servers_available"] = True
                elif status_key == "chinese_db":
                    st["chinese_db_last_success"] = time.time()
                    st["chinese_db_last_error"] = ""
        except Exception:
            pass
    else:
        has = (key and mem_exists(key)) or (not _persist_enabled and os.path.isfile(dest))
        if has:
            print(f"[适配器] 冷启动{label}失败，使用远端存储/本地兜底", flush=True)
            try:
                with _app._download_status_lock:
                    st = _app._download_status
                    if status_key == "servers":
                        st.setdefault("servers_last_success", time.time())
                        if not st.get("servers_last_success"):
                            st["servers_last_success"] = time.time()
                        st["servers_last_error"] = "GitHub 拉取失败，使用 Blob/内存兜底"
                        st["remote_servers_available"] = True
                    elif status_key == "chinese_db":
                        if not st.get("chinese_db_last_success"):
                            st["chinese_db_last_success"] = time.time()
                        st["chinese_db_last_error"] = "GitHub 拉取失败，使用 Blob/内存兜底"
            except Exception:
                pass
        else:
            print(f"[适配器] 冷启动{label}失败，且无兜底", flush=True)
    return result


try:
    _cold_fetch(_app.REMOTE_SERVERS_URL, _app.LOCAL_SERVERS_FILE, "服务器列表", "servers")
except Exception as exc:
    print(f"[适配器] 服务器列表外层异常: {exc!r}", flush=True)

try:
    _cold_fetch(_app.REMOTE_CHINESE_DB_URL, _app.LOCAL_CHINESE_DB_FILE, "标题映射", "chinese_db")
except Exception as exc:
    print(f"[适配器] 标题映射外层异常: {exc!r}", flush=True)

try:
    _app.ensure_frontend_exists()
except Exception as exc:
    print(f"[适配器] ensure_frontend_exists 失败: {exc!r}", flush=True)

try:
    _app.ctx.refresh_config(force=True)
except Exception as exc:
    print(f"[适配器] ctx.refresh_config 失败: {exc!r}", flush=True)

if _persist_enabled:
    print(
        f"{_FS_TAG} hydrate={_persist_pull_results}；读写均走内存并直连 {_PERSIST_ACTIVE}，不再写 /tmp",
        flush=True,
    )


class handler(_app.MonitorHandler):
    """路由前缀还原；写操作结束后强制把相关 key push 到 Blob。"""

    _PREFIX = "/api/index"

    # 这些 POST 会改 servers_manual.json
    _SERVERS_WRITE_PREFIXES = (
        "/api/servers/add",
        "/api/servers/delete",
        "/api/servers/edit",
        "/api/servers/reorder",
    )
    _ENV_WRITE_PREFIXES = (
        "/api/env/save",
        "/api/env/set-password",
    )

    @classmethod
    def _strip_prefix(cls, path: str) -> str:
        p = path or "/"
        if p.startswith(cls._PREFIX):
            p = p[len(cls._PREFIX) :]
        return p or "/"

    def do_GET(self) -> None:
        self.path = self._strip_prefix(self.path)
        path_only = (self.path or "/").split("?", 1)[0]
        # 读 snapshot/servers 前从 Blob 拉最新自定义列表，避免多实例内存脏读
        if _persist_enabled and (
            path_only.startswith("/api/snapshot")
            or path_only == "/api/servers"
            or path_only.startswith("/api/servers?")
        ):
            try:
                persist_revalidate_user_config(force=False)
            except Exception as exc:
                print(f"{_FS_TAG} GET revalidate 失败: {exc!r}", flush=True)
        super().do_GET()

    def do_POST(self) -> None:
        self.path = self._strip_prefix(self.path)
        path_only = (self.path or "/").split("?", 1)[0]
        # 写之前也先 revalidate，降低丢更新/覆盖别人写入的概率
        if _persist_enabled and (
            any(path_only == p or path_only.rstrip("/") == p for p in self._SERVERS_WRITE_PREFIXES)
            or any(path_only == p or path_only.rstrip("/") == p for p in self._ENV_WRITE_PREFIXES)
        ):
            try:
                # 写前强制拉一次，合并到最新
                persist_revalidate_user_config(force=True)
            except Exception as exc:
                print(f"{_FS_TAG} POST 前 revalidate 失败: {exc!r}", flush=True)
        super().do_POST()
        # 兜底：写接口结束后强制 push，保证其它实例能 revalidate 到
        if not _persist_enabled:
            return
        try:
            if any(path_only == p or path_only.rstrip("/") == p for p in self._SERVERS_WRITE_PREFIXES):
                ok = mem_force_push("servers_manual")
                # 标记刚写过，短时间内本实例不必立刻再 GET 覆盖自己
                with _revalidate_lock:
                    _revalidate_at["servers_manual"] = time.time()
                print(
                    f"{_FS_TAG} POST {path_only} 后 force_push servers_manual ok={ok}",
                    flush=True,
                )
            elif any(path_only == p or path_only.rstrip("/") == p for p in self._ENV_WRITE_PREFIXES):
                ok = mem_force_push("env")
                with _revalidate_lock:
                    _revalidate_at["env"] = time.time()
                print(f"{_FS_TAG} POST {path_only} 后 force_push env ok={ok}", flush=True)
        except Exception as exc:
            print(f"{_FS_TAG} POST 后 force_push 异常 path={path_only}: {exc!r}", flush=True)
            traceback.print_exc()

    def do_HEAD(self) -> None:
        self.path = self._strip_prefix(self.path)
        super().do_GET()
