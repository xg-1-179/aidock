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
dsh plugin --profile web add aidock        # 装到 profile
# 或在源码目录里：dsh plugin --profile web add "file:<本仓库路径>"
```

装完在「设置 → 移动端」里打开配置页；直连端口默认 41873，可在配置里改。

## 手机怎么连

1. 电脑浏览器打开 `http://127.0.0.1:3080/api/mobile/v1/link/panel`；
2. 页面上有当前六位码和本机可达地址；
3. 手机上填地址 + 六位码即可。地址可以填多个（LAN / 公网 / 自建中转），并行探测取最快的。

## 端点（手机侧用到的）

| 方法 | 路径 | 鉴权 |
|---|---|---|
| GET | `/api/mobile/v1/link/info` | 免（探活 + 取 instanceId） |
| GET | `/api/mobile/v1/link/panel` | 仅本机 |
| GET | `/api/mobile/v1/link/code` | 仅本机（面板续期用） |
| POST | `/api/mobile/v1/link/pair`、`/link/pair2` | 六位码（`X-Aidock-Code` 头） |
| GET | `/api/mobile/v1/sessions` | 设备凭据（E2EE 签名） |
| GET | `/api/mobile/v1/session/messages` | 同上 |
| POST | `/api/mobile/v1/session/send`、`/session/stop` | 同上 |
| GET | `/api/mobile/v1/session/stream` | 同上（SSE） |
| POST | `/api/mobile/v1/approval/respond` | 同上 |

## 改代码时的两条边界（踩过）

- `lib/routes/mobile-api.js` 改完 `POST /api/relay/reload-implementation` 就能生效；
- `lib/impl.js`、`lib/relay/lan-proxy.js`、`lib/mobile/pairing.js` **必须重启宿主的 node 进程**
  （只重开 Electron 壳无效，宿主是独立进程）。

## 许可

与上游一致：MIT。派生关系与改动见本文件与提交历史。
