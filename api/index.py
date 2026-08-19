#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vercel Serverless 入口（薄适配层，不修改 main.py / script.js）。

职责：
1. import 原始 main.py，复用 MonitorHandler。
2. 若配置 BLOB_READ_WRITE_TOKEN：
   - 用「内存虚拟文件系统」接管 env/servers/chinese_db 的读写；
   - 读：内存（冷启动从 Blob / 部署包填充）；
   - 写：更新内存并直接 PUT 到 Blob（不写 /tmp、不落盘）；
3. 未配置 Blob 时退回 /tmp 文件（与旧行为兼容）。
4. 时区 Asia/Shanghai；冷启动拉 GitHub 远程列表并回写 Blob。
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
# Blob REST（对齐 @vercel/blob）
# ===========================================================================
_BLOB_API = (os.environ.get("BLOB_API_URL") or "https://vercel.com/api/blob").strip().rstrip("/")
_BLOB_TOKEN = (os.environ.get("BLOB_READ_WRITE_TOKEN") or "").strip()
_BLOB_ACCESS = (os.environ.get("BLOB_ACCESS") or "private").strip().lower()
if _BLOB_ACCESS not in ("private", "public"):
    _BLOB_ACCESS = "private"
_BLOB_PREFIX = (os.environ.get("BLOB_PREFIX") or "lanplay/").strip()
if _BLOB_PREFIX and not _BLOB_PREFIX.endswith("/"):
    _BLOB_PREFIX += "/"
_BLOB_API_VERSION = (os.environ.get("BLOB_API_VERSION") or "12").strip() or "12"
_blob_enabled = bool(_BLOB_TOKEN)
_blob_effective_access = _BLOB_ACCESS


def _parse_store_id_from_token(token: str) -> str:
    parts = (token or "").split("_")
    if len(parts) >= 4:
        return parts[3]
    return ""


_BLOB_STORE_ID = (
    (os.environ.get("BLOB_STORE_ID") or "").strip().removeprefix("store_")
    or _parse_store_id_from_token(_BLOB_TOKEN)
)

# 逻辑名 → blob pathname
_BLOB_PATHNAMES: dict[str, str] = {
    "env": f"{_BLOB_PREFIX}env.json",
    "servers_manual": f"{_BLOB_PREFIX}servers_manual.json",
    "servers": f"{_BLOB_PREFIX}servers.json",
    "chinese_db": f"{_BLOB_PREFIX}chinese_db.json",
}

# 虚拟路径根（不存在于真实磁盘；仅作 main.py 的路径字符串）
_VFS_ROOT = "/__blobfs__"
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
    return _VFS_PATHS if _blob_enabled else _TMP_PATHS


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
_mem: dict[str, bytes | None] = {k: None for k in _BLOB_PATHNAMES}
# key → 单调递增版本（充当 mtime_ns）
_mem_ver: dict[str, int] = {k: 0 for k in _BLOB_PATHNAMES}
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
    print(f"[BlobFS] 内存已更新 key={key} size={len(raw)}B ver={ver} push={push}", flush=True)
    if push and _blob_enabled:
        try:
            ok = _blob_put(_BLOB_PATHNAMES[key], raw)
            if ok:
                print(f"[BlobFS] 已同步 Blob key={key} size={len(raw)}B pathname={_BLOB_PATHNAMES[key]}", flush=True)
            else:
                print(f"[BlobFS] 同步 Blob 失败 key={key}（内存已是新值；下次冷启动可能回潮）", flush=True)
        except Exception as exc:
            print(f"[BlobFS] 同步 Blob 异常 key={key}: {exc!r}", flush=True)


def mem_force_push(key: str) -> bool:
    """把当前内存中的 key 强制 PUT 到 Blob（删除服务器后兜底同步）。"""
    if not _blob_enabled or key not in _BLOB_PATHNAMES:
        return False
    data = mem_get(key)
    if data is None:
        # 不存在则推送空数组/空对象，避免 Blob 残留旧自定义服务器
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
        ok = _blob_put(_BLOB_PATHNAMES[key], data)
        print(
            f"[BlobFS] force_push key={key} ok={ok} size={len(data)}B pathname={_BLOB_PATHNAMES[key]}",
            flush=True,
        )
        return bool(ok)
    except Exception as exc:
        print(f"[BlobFS] force_push 异常 key={key}: {exc!r}", flush=True)
        return False


# 多实例一致性：其它实例写了 Blob 后，本实例内存可能仍是旧值。
# 按 TTL 从 Blob 重新拉取关键 key（尤其 servers_manual / env）。
_revalidate_lock = threading.RLock()
_revalidate_at: dict[str, float] = {}
_REVALIDATE_TTL = float(os.environ.get("BLOB_REVALIDATE_TTL", "3") or 3)


def blob_revalidate_key(key: str, *, force: bool = False) -> bool:
    """若 Blob 上内容更新，覆盖本实例内存。返回是否发生了变更。"""
    if not _blob_enabled or key not in _BLOB_PATHNAMES:
        return False
    now = time.time()
    with _revalidate_lock:
        last = _revalidate_at.get(key, 0.0)
        if not force and (now - last) < _REVALIDATE_TTL:
            return False
        _revalidate_at[key] = now
    try:
        remote = _blob_get(_BLOB_PATHNAMES[key])
    except Exception as exc:
        print(f"[BlobFS] revalidate GET 失败 key={key}: {exc!r}", flush=True)
        return False
    if remote is None:
        # Blob 无对象：若本地是用户配置，保留本地；servers_manual 空对象视为 []
        return False
    if not _validate_payload(key, remote):
        print(f"[BlobFS] revalidate 校验失败 key={key}", flush=True)
        return False
    local = mem_get(key)
    if local is not None and local == remote:
        return False
    # 不 push 回 Blob，只更新内存
    with _mem_lock:
        _mem[key] = bytes(remote)
        ver = _bump(key)
    print(
        f"[BlobFS] revalidate 已用 Blob 覆盖内存 key={key} size={len(remote)}B ver={ver}",
        flush=True,
    )
    # 配置签名变化后强制 refresh
    try:
        if key in ("servers_manual", "servers", "chinese_db"):
            _app.ctx.refresh_config(force=True)
        if key == "env":
            _app.apply_r2_config_to_runtime(_app.load_env_config())
    except Exception as exc:
        print(f"[BlobFS] revalidate 后 refresh 失败: {exc!r}", flush=True)
    return True


def blob_revalidate_user_config(*, force: bool = False) -> None:
    """读路径前刷新用户相关配置（自定义服务器 + env）。"""
    if not _blob_enabled:
        return
    blob_revalidate_key("servers_manual", force=force)
    blob_revalidate_key("env", force=force)



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
    if not _blob_enabled:
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
    if not _blob_enabled:
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


def _validate_payload(key: str, data: bytes) -> bool:
    try:
        parsed = json.loads(data.decode("utf-8-sig"))
    except Exception as exc:
        print(f"[BlobFS] {key} 不是合法 JSON: {exc!r}", flush=True)
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


def blob_hydrate_memory() -> dict[str, bool]:
    """冷启动：Blob → 内存；缺失则用部署包。"""
    results: dict[str, bool] = {}
    if not _blob_enabled:
        print("[BlobFS] 未配置 BLOB_READ_WRITE_TOKEN，使用 /tmp 文件模式", flush=True)
        return results
    print(
        f"[BlobFS] 内存直连模式 api={_BLOB_API} access={_BLOB_ACCESS} "
        f"store={_BLOB_STORE_ID or '?'} prefix={_BLOB_PREFIX!r} version={_BLOB_API_VERSION}",
        flush=True,
    )
    deploy_names = {
        "env": "env.json",
        "servers_manual": None,  # 仓库通常没有
        "servers": "servers.json",
        "chinese_db": "chinese_db.json",
    }
    for key, pathname in _BLOB_PATHNAMES.items():
        data = None
        try:
            data = _blob_get(pathname)
        except Exception as exc:
            print(f"[BlobFS] pull {key} 异常: {exc!r}", flush=True)
        if data and _validate_payload(key, data):
            with _mem_lock:
                _mem[key] = data
                _bump(key)
            print(f"[BlobFS] 从 Blob 载入 {key} size={len(data)}B", flush=True)
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
                        print(f"[BlobFS] 部署包兜底 {key} size={len(raw)}B", flush=True)
                        results[key] = False
                        continue
                except Exception as exc:
                    print(f"[BlobFS] 部署包读取失败 {key}: {exc!r}", flush=True)
        print(f"[BlobFS] {key} 远端与部署包均无数据", flush=True)
        results[key] = False
    return results


# ===========================================================================
# 未启用 Blob：/tmp 回退（复制部署包）
# ===========================================================================
if not _blob_enabled:
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
                print(f"[BlobFS] TextIO close 写回失败 {self._key}: {exc!r}", flush=True)
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
                        print(f"[BlobFS] 未知 tmp 写路径 {self._tmp_path}", flush=True)
                elif self._key:
                    mem_set(self._key, data, push=True)
            except Exception as exc:
                print(f"[BlobFS] BinaryIO close 失败: {exc!r}", flush=True)
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
    if not _blob_enabled and not str(path_s).startswith(_VFS_ROOT):
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
    if _blob_enabled:
        key = _path_to_key(path)
        if key is not None:
            st = _mem_stat(key)
            if st is None:
                raise FileNotFoundError(2, "No such file or directory", os.fspath(path))
            return st
    return _orig_os_stat(path, *args, **kwargs)


def _os_path_isfile_patch(path):
    if _blob_enabled:
        key = _path_to_key(path)
        if key is not None:
            return mem_exists(key)
        if _is_managed_tmp_sidecar(path):
            return _norm_path(path) in _mem_tmp
    return _orig_os_path_isfile(path)


def _os_path_exists_patch(path):
    if _blob_enabled:
        key = _path_to_key(path)
        if key is not None:
            return mem_exists(key)
        if _is_managed_tmp_sidecar(path):
            return _norm_path(path) in _mem_tmp
    return _orig_os_path_exists(path)


def _os_path_getsize_patch(path):
    if _blob_enabled:
        key = _path_to_key(path)
        if key is not None:
            data = mem_get(key)
            if data is None:
                raise FileNotFoundError(2, "No such file or directory", os.fspath(path))
            return len(data)
    return _orig_os_path_getsize(path)


def _os_replace_patch(src, dst):
    if _blob_enabled:
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
            print(f"[BlobFS] os.replace 提交下载结果 → {key} size={len(data)}B", flush=True)
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
            print(f"[BlobFS] os.replace 跳过空 tmp {src_s}", flush=True)
            return
    return _orig_os_replace(src, dst)


def _os_remove_patch(path):
    if _blob_enabled:
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
    if _blob_enabled and _path_to_key(self) is not None:
        return mem_exists(_path_to_key(self))  # type: ignore[arg-type]
    return _orig_path_is_file(self)


def _path_exists_patch(self: Path) -> bool:
    if _blob_enabled and _path_to_key(self) is not None:
        return mem_exists(_path_to_key(self))  # type: ignore[arg-type]
    return _orig_path_exists(self)


def _path_stat_patch(self: Path, *args, **kwargs):
    if _blob_enabled:
        key = _path_to_key(self)
        if key is not None:
            st = _mem_stat(key)
            if st is None:
                raise FileNotFoundError(2, "No such file or directory", str(self))
            return st
    return _orig_path_stat(self, *args, **kwargs)


def _path_read_text_patch(self: Path, encoding: str | None = "utf-8", errors: str | None = None) -> str:
    if _blob_enabled:
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
    if _blob_enabled:
        key = _path_to_key(self)
        if key is not None:
            enc = encoding or "utf-8"
            raw = data.encode(enc.replace("-sig", ""), errors=errors or "strict")
            mem_set(key, raw, push=True)
            return len(raw)
    return _orig_path_write_text(self, data, encoding=encoding, errors=errors, newline=newline)  # type: ignore[call-arg]


def _path_read_bytes_patch(self: Path) -> bytes:
    if _blob_enabled:
        key = _path_to_key(self)
        if key is not None:
            data = mem_get(key)
            if data is None:
                raise FileNotFoundError(2, "No such file or directory", str(self))
            return data
    return _orig_path_read_bytes(self)


def _path_write_bytes_patch(self: Path, data: bytes) -> int:
    if _blob_enabled:
        key = _path_to_key(self)
        if key is not None:
            mem_set(key, bytes(data), push=True)
            return len(data)
    return _orig_path_write_bytes(self, data)


def _path_open_patch(self: Path, mode: str = "r", *args, **kwargs):
    """Path.open → 走同一套 VFS open，避免 pathlib 内部绕过 builtins.open。"""
    return _open_patch(self, mode, *args, **kwargs)


def _install_vfs_patches() -> None:
    if not _blob_enabled:
        print("[BlobFS] 跳过 VFS patch（无 BLOB token，使用真实 /tmp）", flush=True)
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
    print("[BlobFS] 已安装内存虚拟文件系统 patch（直连 Blob，不写 /tmp）", flush=True)


_install_vfs_patches()

# AppContext 签名在 blob 模式下用内存版本
if _blob_enabled:
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
if _blob_enabled:
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
_blob_pull_results = blob_hydrate_memory() if _blob_enabled else {}

try:
    _app.apply_r2_config_to_runtime(_app.load_env_config())
    print("[适配器] env 配置已应用到运行时全局", flush=True)
except Exception as exc:
    print(f"[适配器] apply_r2_config_to_runtime 失败: {exc!r}", flush=True)


# 远程下载改为纯内存：不经 dest.*.tmp 落盘，校验 JSON 后 mem_set(+Blob)
_orig_download_remote_file = _app._download_remote_file


def _download_remote_file_mem(url: str, dest_path: str) -> bool:
    key = _path_to_key(dest_path)
    if not (_blob_enabled and key is not None):
        return _orig_download_remote_file(url, dest_path)

    # 复用 main 的候选 URL / SSL
    try:
        candidates = _app._remote_candidate_urls(url)
    except Exception:
        candidates = [url]
    last_err = None
    for cand_url in candidates:
        try:
            req = urllib.request.Request(
                cand_url,
                headers={"User-Agent": f"{_app.APP_NAME}/1.0", "Accept": "application/json"},
            )
            ctx_ssl = getattr(_app, "SSL_CTX", None)
            with urllib.request.urlopen(req, timeout=15, context=ctx_ssl) as resp:
                data = resp.read()
            # 校验 JSON
            json.loads(data.decode("utf-8-sig"))
            mem_set(key, data, push=True)
            if cand_url != url:
                print(f"[远程下载] 经代理成功 {cand_url}", flush=True)
            print(f"[BlobFS] 远程下载已入内存/Blob key={key} size={len(data)}B", flush=True)
            return True
        except Exception as exc:
            last_err = exc
            print(f"[远程下载] 下载失败 {cand_url} -> blobfs:{key}: {exc}", flush=True)
            continue
    if last_err:
        print(f"[BlobFS] 远程下载全部失败 key={key}: {last_err!r}", flush=True)
    return False


_app._download_remote_file = _download_remote_file_mem  # type: ignore[assignment]


def _cold_fetch(url: str, dest: str, label: str, status_key: str) -> bool:
    print(f"[适配器] 冷启动拉取{label} url={url} -> {dest}", flush=True)
    try:
        ok = _app._download_remote_file(url, dest)
    except Exception as exc:
        print(f"[适配器] 冷启动{label}异常: {exc!r}", flush=True)
        traceback.print_exc()
        ok = False

    key = _path_to_key(dest)
    if ok:
        size = -1
        if key and mem_exists(key):
            size = len(mem_get(key) or b"")
        elif os.path.isfile(dest):
            try:
                size = os.path.getsize(dest)
            except Exception:
                pass
        print(f"[适配器] 冷启动{label}成功 size={size}B", flush=True)
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
        has = (key and mem_exists(key)) or (not _blob_enabled and os.path.isfile(dest))
        if has:
            print(f"[适配器] 冷启动{label}失败，使用 BlobFS/本地兜底", flush=True)
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
    return ok


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

if _blob_enabled:
    print(
        f"[BlobFS] hydrate={_blob_pull_results}；读写均走内存并直连 Blob，不再写 /tmp",
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
        if _blob_enabled and (
            path_only.startswith("/api/snapshot")
            or path_only == "/api/servers"
            or path_only.startswith("/api/servers?")
        ):
            try:
                blob_revalidate_user_config(force=False)
            except Exception as exc:
                print(f"[BlobFS] GET revalidate 失败: {exc!r}", flush=True)
        super().do_GET()

    def do_POST(self) -> None:
        self.path = self._strip_prefix(self.path)
        path_only = (self.path or "/").split("?", 1)[0]
        # 写之前也先 revalidate，降低丢更新/覆盖别人写入的概率
        if _blob_enabled and (
            any(path_only == p or path_only.rstrip("/") == p for p in self._SERVERS_WRITE_PREFIXES)
            or any(path_only == p or path_only.rstrip("/") == p for p in self._ENV_WRITE_PREFIXES)
        ):
            try:
                # 写前强制拉一次，合并到最新
                blob_revalidate_user_config(force=True)
            except Exception as exc:
                print(f"[BlobFS] POST 前 revalidate 失败: {exc!r}", flush=True)
        super().do_POST()
        # 兜底：写接口结束后强制 push，保证其它实例能 revalidate 到
        if not _blob_enabled:
            return
        try:
            if any(path_only == p or path_only.rstrip("/") == p for p in self._SERVERS_WRITE_PREFIXES):
                ok = mem_force_push("servers_manual")
                # 标记刚写过，短时间内本实例不必立刻再 GET 覆盖自己
                with _revalidate_lock:
                    _revalidate_at["servers_manual"] = time.time()
                print(
                    f"[BlobFS] POST {path_only} 后 force_push servers_manual ok={ok}",
                    flush=True,
                )
            elif any(path_only == p or path_only.rstrip("/") == p for p in self._ENV_WRITE_PREFIXES):
                ok = mem_force_push("env")
                with _revalidate_lock:
                    _revalidate_at["env"] = time.time()
                print(f"[BlobFS] POST {path_only} 后 force_push env ok={ok}", flush=True)
        except Exception as exc:
            print(f"[BlobFS] POST 后 force_push 异常 path={path_only}: {exc!r}", flush=True)
            traceback.print_exc()

    def do_HEAD(self) -> None:
        self.path = self._strip_prefix(self.path)
        super().do_GET()
