# LAN-Play 房间监控 · 一键部署包

基于原版 `main.py` / `script.js`，增加安全密码明文化与环境变量支持；`api/index.py` 为 Vercel 适配层（含 Blob 持久化）+ 部署相关配置。

仓库地址：`https://github.com/jieluojun/lanplay-monitor-vercel`

| 部署方式 | 适合场景 | 服务器列表 | 添加自定义服务器 / 环境变量配置 |
|---|---|---|---|
| **Vercel** | 公网页面 | ✅ 预打包 + 定时刷新；Blob 缓存远程列表/标题映射 | ✅ 配 `BLOB_READ_WRITE_TOKEN` 后持久化到 Vercel Blob |
| **Docker** | 完整功能 | ✅ 原版后台线程实时下载 | ✅ 本地文件 / 挂卷永久保存 |

---

## 目录结构

| 文件 | 说明 |
|---|---|
| `main.py` / `script.js` | 后端 / 前端（安全密码明文 + 环境变量；设置页可编辑） |
| `servers.json` | 远端服务器列表（部署时预取，13 台） |
| `chinese_db.json` | 游戏标题映射（部署时预取，1 万+ 条） |
| `env.json.example` | 环境配置模板（复制成 `env.json` 放进仓库根目录） |
| `api/index.py` | Vercel 适配层（路由前缀还原 + 时区/日志 + /tmp 重定向 + **Vercel Blob 持久化**） |
| `vercel.json` | Vercel 路由 / 函数配置 |
| `.github/workflows/*` | deploy / refresh-servers / docker |
| `Dockerfile` / `docker-compose.yml` | 完整功能镜像 / 一键启动 |

---

# 方式一：Vercel 部署

## 一键部署

点击下面按钮，Vercel 自动从仓库克隆，**Git Scope / Project Name / Private Repository Name 三个字段一次性预填好**：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jieluojun/lanplay-monitor-vercel&project-name=lanplay-monitor-vercel&repository-name=lanplay-monitor-vercel)

或手动访问：

```
https://vercel.com/new/clone?repository-url=https://github.com/jieluojun/lanplay-monitor-vercel&project-name=lanplay-monitor-vercel&repository-name=lanplay-monitor-vercel
```

三个参数含义（Vercel 官方支持）：

| 参数 | 预填的字段 |
|---|---|
| `repository-url=…` | 「Cloning from GitHub」（源仓库 + 分支） |
| `project-name=…` | 「Project Name」（Vercel 项目名 = 部署后访问的 `<name>.vercel.app` 子域名） |
| `repository-name=…` | **「Private Repository Name」**（在你账号下新建的私有 Git 仓库名） |

按引导完成（Framework 选 **Other**）。

## 自动部署（生产推荐）

⚠️ **接 Vercel 之前必须配置 3 个 GitHub Secret**，否则每次 push workflow 都会因 secret 缺失而跳过部署步骤、抛 warning（push 仍然绿 ✔，但没真正部署到 Vercel）。

### 步骤

1. **fork 本仓库**到你自己的 GitHub（Star 不够，依旧需要 fork 才能在你自己账号下设置 Actions Secret 和 Actions 触发）。
2. 进入 fork 仓库 → `Settings → Secrets and variables → Actions → New repository secret`，**逐条添加**下面三个值：

   | Secret 名 | 值从哪里拿 |
   |---|---|
   | `VERCEL_TOKEN` | Vercel → [Account Settings → Tokens → Create Token](https://vercel.com/account/tokens)。Scopes 选 **Full Access**，TTL 选「No expiration」，创建后**只展示一次**立刻复制 |
   | `VERCEL_ORG_ID` | Vercel → 团队 / 个人页 → `Settings → General` → 「Your ID」一栏复制（个人账号就是 user id） |
   | `VERCEL_PROJECT_ID` | Vercel 上**先用一键 deploy 按钮建出这个项目**（首次会自动填好项目名 `lanplay-monitor-vercel`），然后进 Vercel 项目 → `Settings → General` → 「Project ID」复制 |

3. 添加完三个 secret 后再 push 到 `main` / `master`，workflow 会自动跑生产部署；发 PR 自动跑预览部署。

> 不接 Vercel 只想跑 Docker？直接忽略这个 section，下面的「方式二」完全和 GitHub Secrets 无关。

## Vercel 限制 & 解决方案

| 问题 | 原因 | 解决方案 |
|---|---|---|
| 远端服务器列表拉取 | Vercel 不能跑后台线程 | ① 仓库预打包 13 台兜底；② `api/index.py` 冷启动直连拉取最新；③ GitHub Action 每 6h 同步并触发重新部署 |
| 添加 / 编辑自定义服务器、保存环境变量、远程列表/标题映射缓存 | Vercel 文件系统只读，默认只写 `/tmp`（冷启动清空） | **推荐**：项目接 Vercel Blob，配置 `BLOB_READ_WRITE_TOKEN`，适配层内存直连 Blob 同步 `env.json` / `servers_manual.json` / `servers.json` / `chinese_db.json`（不写 /tmp）；或改用 Docker 挂卷 |

> UDP 局域网扫描在 Vercel 上不可用（平台禁用原始 UDP），只能扫公网服务器；
> 日志长轮询受 60s 函数时长限制。

## Vercel Blob 持久化（配置 + 远程下载缓存）

接上 **Blob** 后，适配层使用 **内存虚拟文件系统（BlobFS）直连 Blob**，**不再写入 `/tmp`**：

1. **冷启动 hydrate**：从 Blob 拉下列对象进内存（缺失则用部署包兜底）
   - `lanplay/env.json` — 环境变量配置（含安全密码）
   - `lanplay/servers_manual.json` — 用户自定义服务器
   - `lanplay/servers.json` — 远程公网服务器列表
   - `lanplay/chinese_db.json` — 游戏标题映射
2. **运行时读写**：`main.py` 仍按「本地文件路径」调用；适配层把路径映射到内存，**读内存 / 写内存并立刻 PUT 到 Blob**
3. **远程下载**：GitHub 拉成功后直接写入内存 + Blob（不经 `/tmp`）
4. **未配置 `BLOB_READ_WRITE_TOKEN`**：退回旧的 `/tmp` 文件模式（不持久）

`main.py` / `script.js` **无需修改**。

### 接入步骤

1. 打开 Vercel 项目 → **Storage** → **Create Database / Browse Storage** → 选 **Blob**
2. Access 建议选 **Private**（`env.json` 含密钥；选 Public 也能跑，适配层会按 `BLOB_ACCESS` 上传）
3. 创建并 **Connect to Project**（Production / Preview）；Vercel 会自动注入：
   - `BLOB_READ_WRITE_TOKEN`（必需）
4. 重新部署一次。打开「实时运行日志」，应看到：
   - `[Blob] 已启用持久化 …`
   - 首次还没有远端对象时：`pull …：远端不存在`（正常）
   - 在网页保存一次配置或添加服务器后：`[Blob] PUT 成功 …`

### 相关环境变量

| OS 变量 | 默认 | 说明 |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | （空） | 有值即启用 Blob 持久化；空则行为与旧版相同（仅 `/tmp`） |
| `BLOB_ACCESS` | `private` | 必须与 store 创建时一致：`private` / `public`（请求头为 `x-vercel-blob-access`） |
| `BLOB_STORE_ID` | 从 token 解析 | 一般不用填；token 形如 `vercel_blob_rw_<storeId>_…` 时可自动解析 |
| `BLOB_PREFIX` | `lanplay/` | 对象路径前缀 |
| `BLOB_API_VERSION` | `12` | 对齐官方 `@vercel/blob` SDK；一般不用改 |
| `BLOB_API_URL` | `https://vercel.com/api/blob` | Blob 控制面 API 基址 |

### 注意

- **密钥安全**：优先 Private store；即使 Public，也不要把 blob URL 发到前端。完整配置仍受安全密码门禁保护。
- **access 必须匹配 store**：Private store 只能 `BLOB_ACCESS=private`（默认）。若日志出现 `Cannot use public access on a private store`，说明旧版用了错误请求头；本版已改为官方 `x-vercel-blob-access`。
- **并发**：多实例同时保存时 last-write-wins；个人/小流量场景通常可接受。
- **与 R2/COS 无关**：Blob 存应用配置 + 远程下载缓存（上述 4 个 JSON）；聊天媒体/头像仍走你配置的 R2 或腾讯云 COS。
- **体积**：`chinese_db.json` 约 0.5MB 级，Blob 免费额度通常足够；若不想缓存标题映射，可自行在 Blob 控制台删掉 `lanplay/chinese_db.json`（不影响其它文件）。
- **Docker 部署不受影响**：`BLOB_*` 仅 Vercel 适配层读取；Docker 继续写本地文件/挂卷。

## 运行日志（适配器层新增）

打开页面右上「实时运行日志」面板：

- **时区**：所有 `更新于 HH:MM:SS` 都是上海时间（UTC+8），不用看容器时区；
- **冷启动诊断**：冷启动会打印「正在拉取 URL → 路径」「成功 size=N」或「失败原因」；
- **远程下载状态页面**：`[远程下载] 服务器列表: 正常 | 上次成功: HH:MM:SS` 表示远端拉取成功；
  停在「不可用（使用内置兜底）」时，看同屏 `[WARN]` 的 `<urlopen error ...>` 判断是 DNS 还是网络问题。

---

# 环境变量（合并版：env.json 字段 + OS 环境变量）

下方一张表覆盖所有可配置项：

- 第 1-2 列：分别给「env.json 文件路径」和「OS 环境变量」两条配置途径；同名时 OS 优先级高
- 第 3-5 列：类型 / 默认 / 说明
- 函数未实现 `force_tls` 例外的项，OS 变量列写 `—`
- 末段「调优变量」组里只有 OS 环境变量可用（env.json 无对应字段，列 1 留空）

**OS 变量命名规则**：`json_path_section.field_name` → `SECTION_FIELD_NAME`（点 → `_`、全大写），
例如 `cloudflare_r2.max_upload_mb` → `CLOUDFLARE_R2_MAX_UPLOAD_MB`。**Vercel 项目
Settings → Environment Variables** 里直接配同名变量即可生效，**不需要在 env.json 里重复写**。

| 字段 / 路径 | OS 变量名 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| **goeasy · GoEasy 聊天** | | | | |
| `goeasy.appkey` | `GOEASY_APPKEY` | str | `""` | GoEasy 控制台 → 应用概览里的 AppKey；空 → 前端聊天禁用 |
| `goeasy.host` | `GOEASY_HOST` | str | `""` | REST 接入点：`https://rest-hz.goeasy.io`（杭州）/ `https://rest-singapore.goeasy.io`（新加坡） |
| `goeasy.force_tls` | — | bool | `true` | 强制 HTTPS（生产必须；main.py 仅从 env.json 读） |
| **storage · 提供方选择** | | | | |
| `storage.provider` | `STORAGE_PROVIDER` | enum | `"r2"` | `"r2"` = Cloudflare R2；`"cos"` = 腾讯云 COS |
| **cloudflare_r2 · provider="r2" 时生效** | | | | |
| `cloudflare_r2.account_id` | `R2_ACCOUNT_ID` | str | `""` | Cloudflare 主页右侧 Account ID |
| `cloudflare_r2.access_key_id` | `R2_ACCESS_KEY_ID` | str | `""` | R2 → Manage R2 API Tokens → Create API Token，权限 **Object Read & Write** |
| `cloudflare_r2.secret_access_key` | `R2_SECRET_ACCESS_KEY` | str | `""` | 同上配对密钥（弹窗一次性显示） |
| `cloudflare_r2.bucket_name` | `R2_BUCKET_NAME` | str | `""` | R2 桶名 |
| `cloudflare_r2.public_url` | `R2_PUBLIC_URL` | str | `""` | 自定义公开域名（带 `https://`、别带 `/`）；空 → `{bucket}.r2.dev` 兜底 |
| `cloudflare_r2.max_upload_mb` | `R2_MAX_UPLOAD_MB` | int | `0` | 单文件上传上限（MB），头像强制取 `min(this, 5)` |
| `cloudflare_r2.max_storage_mb` | `R2_MAX_STORAGE_MB` | int | `0` | 桶总大小上限（MB），达到自动清聊天媒体、保留头像 |
| `cloudflare_r2.cf_api_token` | `CF_API_TOKEN` | str | `""` | Cloudflare API Token（含 Account → R2 → Edit），用于关 r2.dev 公共访问 |
| **tencent_cos · provider="cos" 时生效** | | | | |
| `tencent_cos.secret_id` | `COS_SECRET_ID` | str | `""` | 腾讯云 SecretId |
| `tencent_cos.secret_key` | `COS_SECRET_KEY` | str | `""` | 腾讯云 SecretKey |
| `tencent_cos.bucket` | `COS_BUCKET` | str | `""` | 桶名（**含 APPID 后缀**），如 `mybucket-1250000000` |
| `tencent_cos.region` | `COS_REGION` | str | `""` | 桶地域：`ap-guangzhou` / `ap-shanghai` / `ap-beijing` / `ap-hongkong` |
| `tencent_cos.public_url` | `COS_PUBLIC_URL` | str | `""` | CDN / 自定义域名；空 → `{bucket}.cos.{region}.myqcloud.com` 兜底 |
| `tencent_cos.max_upload_mb` | `COS_MAX_UPLOAD_MB` | int | `0` | 单文件上传上限（MB） |
| `tencent_cos.max_storage_mb` | `COS_MAX_STORAGE_MB` | int | `0` | 桶总大小上限（MB） |
| **security · 安全密码** | | | | |
| `security.password` | `SECURITY_PASSWORD` | str | `""` | 环境变量配置页的安全密码（**明文**）。OS 变量优先于 env.json；长度建议 ≥ 4。可通过页面右上「环境变量配置」设置，或直接写进 env.json / OS 环境变量 |
| **调优变量（仅 OS 环境变量，env.json 无对应字段）** | | | | |
| — | `PORT` | int | `11451` | HTTP 服务端口（Docker 内通常不需改） |
| — | `REQUEST_TIMEOUT` | float | `1` | 上游 GraphQL / REST 请求超时（秒），网慢建议 3-5 |
| — | `CACHE_TTL` | float | `1` | `/api/snapshot` 缓存有效期（秒），建议保持 1 |
| — | `MAX_WORKERS` | int | `8` | 同时扫描服务器线程数（最大 64） |
| — | `MAX_CONCURRENT_REQUESTS` | int | `48` | 同时 HTTP 请求上限（长轮询占用较多） |
| — | `MAX_KEEPALIVE_ROOMS` | int | `300` | 每服务器保活房间数上限 |
| — | `MAX_JSON_BODY_BYTES` | int | `2097152` | JSON 请求体上限（字节），超限 400 |
| — | `CONFIG_RELOAD_INTERVAL` | float | `10` | 重读配置最小间隔（秒），避免每秒轮询反复读盘 |
| — | `GC_INTERVAL` | int | `120` | 内存看门狗执行间隔（秒），做完整 GC + 归还堆内存 |
| — | `UDP_SCAN_SECONDS` | float | `0.5` | 每次主动扫描 LAN 房间的窗口（秒） |
| — | `DOWNLOAD_DIR` | str | `/storage/emulated/0/Download` | 内置下载器在 Android 上的保存目录 |
| — | `DOWNLOAD_MAX_MB` | int | `2048` | 内置下载器单文件最大容量（MB），超出拒绝 |
| — | `DOWNLOAD_TIMEOUT` | float | `300` | 内置下载器单任务超时（秒） |
| — | `REMOTE_UPDATE_PROXY` | str | `https://v6.gh-proxy.org` | GitHub raw 拉取代理；**Vercel 上推荐设为 `""` 走直连** |
| — | `SERVERS_FILE` | str | `""` | 覆盖默认「手动服务器列表」JSON 路径；Docker 挂持久卷时常用 |
| — | `BLOB_READ_WRITE_TOKEN` | str | `""` | **Vercel 专用**：启用 Blob 持久化 |
| — | `BLOB_ACCESS` | enum | `"private"` | 与 store 一致：`private` / `public` |
| — | `BLOB_STORE_ID` | str | 自 token 解析 | 可选；private CDN 直读需要 |
| — | `BLOB_PREFIX` | str | `"lanplay/"` | Blob 对象路径前缀 |
| — | `BLOB_API_VERSION` | str | `"12"` | 对齐官方 SDK |
| — | `BLOB_API_URL` | str | `https://vercel.com/api/blob` | 控制面 API 基址 |

**密码设置**（三选一，OS 环境变量优先）：

1. 页面右上「环境变量配置」→ 公网首次进入会强制设置；之后可 `POST /api/env/set-password {password: "..."}` 修改（已设时需带 `old_password`）
2. 在 `env.json` 写：`"security": { "password": "你的密码" }`
3. OS / Docker / Vercel 环境变量：`SECURITY_PASSWORD=你的密码`（**优先级最高**，覆盖 env.json）

访问策略：

- **局域网 / 本机** → 始终跳过安全密码（无论是否已设置），可直接读写完整配置
- 未设密码 + 公网 → 拒绝读取，要求先设
- 已设密码 + 公网 → 必须带正确密码才能读写（请求头 `X-Env-Password` 或 query/body 的 `password`）

> 旧版 `password_hash` / `salt` / `set_at` 三字段已废弃，统一为单一明文 `password`。若你还留着旧字段，请删掉后重新设置一次密码。

**env.json 部署方式二选一**：

- **方式 A（推荐）**：Vercel 项目 → Settings → Environment Variables 配同名环境变量（OS 优先级高）
- **方式 B**：复制 `env.json.example` 为 `env.json`，填好放进仓库根目录（密钥会进 Git 历史，仅私有仓库适用）

### Vercel 推荐配置示例

`项目 → Settings → Environment Variables` 里加这几条（其中 `/u`/`/r2`/`/goeasy`/`/cos` 等密钥按需填）：

```
# 时区 / 网络
REQUEST_TIMEOUT=3
REMOTE_UPDATE_PROXY=

# R2 存储（密钥填进 Vercel 而不是 env.json，避免进 Git 历史）
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=xxxxxxxxxxxx
R2_ACCESS_KEY_ID=xxxxxxxxxxxx
R2_SECRET_ACCESS_KEY=xxxxxxxxxxxx
R2_BUCKET_NAME=lanplay-chat
R2_PUBLIC_URL=https://chat.example.com
R2_MAX_UPLOAD_MB=8
R2_MAX_STORAGE_MB=256

# 聊天
GOEASY_APPKEY=xxxxxxxxxxxx
GOEASY_HOST=https://rest-hz.goeasy.io

# 安全密码（保护环境变量配置页；公网部署强烈建议设置）
SECURITY_PASSWORD=change-me-to-a-strong-password

# Vercel Blob 持久化（Storage → Blob → Connect 后自动注入 token；也可手动粘贴）
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxxx
# BLOB_ACCESS=private
# BLOB_PREFIX=lanplay/

# 内存 / 并发
MAX_WORKERS=8
MAX_CONCURRENT_REQUESTS=64
CACHE_TTL=1
```

---

# 方式二：Docker 完整部署

## 本地 / VPS 一键启动

```bash
docker compose up -d --build
# 打开 http://localhost:11451
```

需要持久化时取消 `docker-compose.yml` 中 `volumes` 的注释。

## 部署到 Railway / Render / Fly.io

- **Railway**：New Project → Deploy from GitHub，自动识别 Dockerfile
- **Render**：New Web Service → 选仓库，Runtime 选 Docker，端口填 `11451`
- **Fly.io**：`fly launch`（自动识别 Dockerfile）→ `fly deploy`

## GitHub Actions 推镜像

工作流 `.github/workflows/docker.yml` 在 push 时构建并推送到 `ghcr.io/jieluojun/lanplay-monitor-vercel`，所有支持 Docker 的平台直接拉：

```bash
docker run -d -p 11451:11451 ghcr.io/jieluojun/lanplay-monitor-vercel:latest
```

---

# 本地验证

```bash
# Vercel 版（本地模拟适配层）
python3 -c "
import sys; sys.path.insert(0, '.')
from api.index import handler
from http.server import ThreadingHTTPServer
ThreadingHTTPServer(('127.0.0.1', 19001), handler).serve_forever()
"
# 然后访问 http://127.0.0.1:19001/

# 完整版（等同 Docker 容器内行为）
python3 main.py
```
