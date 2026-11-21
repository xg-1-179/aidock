# AIDock 插件（服务端）

电脑这一侧的 DSH 插件：把本机的会话、审批、事件流安全地开给手机用。
派生自 MIT 许可的 [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)，
协议仍是 v2 + E2EE，手机端是 [aidock-app](https://github.com/xg-1-179/aidock-app)。

## 与上游的差别

| 改动 | 原因 |
|---|---|
| **六位连接码**（不用扫码）：`GET /api/mobile/v1/link/panel` 面板页 + `POST /link/pair` | 手机上扫码经常扫不动；输入六位码更稳 |
| 连接码 10 分钟轮换，面板页每 20 秒自动续期 | 短码要够安全，又不能让人输到一半过期 |
| 面板页只允许本机打开（非 loopback 直接 403） | 六位码不该被公网读到 |
| `apiProxy` 兼容桥（懒装 + 兜底） | 0.2.2 上宿主不再提供 apiProxy，不补这一层 `/sessions`、`/session/messages` 全是 500 |
| 41873 直连端口上放行配对相关端点 | 手机拿着码来配对时还没有凭据 |

## 装法

```bash
# 1) 从 GitHub 装（推荐；需要 dsh >= 0.2.0）
dsh plugin --profile web add github:xg-1-179/aidock

# 2) 本地源码 / 打包出来的 tgz
npm pack                                  # 生成 aidock-0.1.0.tgz
dsh plugin --profile web add "file:<绝对路径>/aidock-0.1.0.tgz"
```

装完后：

- `dsh plugin --profile web list` 里能看到 `aidock@x.y.z`，profile 的 `package.json`
  的 bundles 里会多一条 `aidock`（这一条决定它的 patch 层会不会被加载）；
- 打开 DSH 设置 → 移动端，能看到面板入口；
- 直连端口默认 `41873`，可在面板里改。

**注意包名一致性**：`package.json` 的 `name` 与 `cordis.patch.yml` 里
`insert: [{ id: dsh-mobile, name: 'aidock' }]` 必须一致。Loader 是按这个名字在
profile 的 `node_modules` 里解析入口的；写错会让整棵插件树加载失败（不是一条警告）。
派生改名时 `host.js` 的 `BIN_NAME` 已改成从 `package.json` 读，不用再手工改。

## 手机怎么连

1. 电脑浏览器打开 `http://127.0.0.1:3080/api/mobile/v1/link/panel`；
2. 页面上有当前六位码和本机可达地址；
3. 手机上填地址 + 六位码即可。地址可以填多个（LAN / 公网 / 自建中转），并行探测取最快的。

## 三种连接方式

| 方式 | 什么时候用 | 怎么配 |
|---|---|---|
| **中继**（默认兜底） | 手机和电脑都不在同一网段、也没有公网端口 | 面板里打开中转，二维码/配对包里会带 `relayUrl`；手机先走中转，失败自动回落直连 |
| **局域网直连** | 同一个 Wi-Fi | 插件自带的 lan-proxy 监听 `0.0.0.0:41873`，手机填 `http://<内网IP>:41873` |
| **公网直连** | 云服务器 / 有公网 IP 和开放端口 | 安全组放行 TCP 41873，手机填 `http://<公网IP>:41873` |

三种地址可以同时填，客户端会**并行探测**、三秒超时、先答话者胜，并把上次成功的那条排在前面。

### 已知问题：公网口上的 401

插件热重载换代后，sidecar 里的 lan-proxy 凭据库可能与宿主不同步：公网口上**配对能过**
（配对端点免鉴权），但之后每个带凭据的请求都被回 `401 缺少或无效的移动 token`，而同一份
凭据打 `127.0.0.1:3080` 完全正常。排查口径见下面「凭据」一节。

绕开的办法是让 41873 换成一条纯转发（不改 Host、不加鉴权，鉴权仍由宿主自己做）：

```bash
# 1) 关掉 sidecar 的监听，腾出端口
curl -X POST http://127.0.0.1:3080/api/relay/config \
     -H 'Content-Type: application/json' -d '{"lanEnabled":false}'

# 2) 起转发（默认 0.0.0.0:41873 -> 127.0.0.1:3080）
node tools/direct-forward.js

# 3) 开机自启（Windows 计划任务）
powershell -ExecutionPolicy Bypass -File scripts/install-direct-task.ps1
```

细节与验证命令见 [docs/DIRECT.md](docs/DIRECT.md)。

### 配对限速（防六位码被爆破）

公网口开着时，六位码只有 100 万种组合，必须限速。插件在 `lib/routes/mobile-api.js`
的 `aidockPairGuard` 里做：同一来源 10 分钟内**码不对**满 8 次即回 `429`（带 `retry-after`），
全机累计失败 20 次直接作废当前连接码。只有「码不对」计数——码对了、封包坏了不锁人。

来源靠转发层盖的两枚章区分：`x-aidock-edge: 1`（公网来路）与 `x-aidock-client: <真实对端 IP>`；
宿主看到的源地址恒为 `127.0.0.1`，换 nginx/frp 时要把这两枚补上，否则所有人都算同一个来源。
参数表见 [docs/DIRECT.md](docs/DIRECT.md) 第六节。

## 端点（手机侧用到的）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/api/mobile/v1/link/info` | 免（探活 + 取 instanceId） |
| GET | `/api/mobile/v1/link/panel` | 仅本机 |
| GET | `/api/mobile/v1/link/code` | 仅本机（面板续期用） |
| POST | `/api/mobile/v1/link/pair`、`/link/pair2` | 六位码（`X-Aidock-Code` 头） |
| GET | `/api/mobile/v1/link/sessions` | 设备凭据（E2EE 签名） |
| GET | `/api/mobile/v1/link/messages` | 同上 |
| POST | `/api/mobile/v1/link/session/new`、`/link/session/send`、`/link/session/stop` | 同上 |
| GET | `/api/mobile/v1/link/session/stream` | 同上（SSE） |
| POST | `/api/mobile/v1/link/approval/respond` | 同上（approve 档） |
| GET | `/api/mobile/v1/link/session/models`、`/link/agent-presets`、`/link/commands` | 同上（view 档） |
| POST | `/api/mobile/v1/link/session/select-model` | 同上（config 档） |
| GET | `/api/mobile/v1/link/workspaces`、`/link/session/search` | 同上 |

> 为什么手机只用 `link/` 别名：宿主给旧路径注册的 handler 早于兼容桥装载，热重载换不掉那份闭包，
> 于是拿不到 `apiProxy`。别名是一组同实现的薄包装，先 `ensureApiProxyBridge(ctx)` 再转调，
> 因此不需要重启宿主就能用上。

## 改代码时的两条边界（踩过）

- `lib/routes/mobile-api.js` 改完 `POST /api/relay/reload-implementation` 就能生效；
- `lib/impl.js`、`lib/relay/lan-proxy.js`、`lib/mobile/pairing.js` **必须重启宿主的 node 进程**
  （只重开 Electron 壳无效，宿主是独立进程）。

## 许可

与上游一致：MIT。派生关系与改动见本文件与提交历史。
