# AIDock 插件

AIDock 是 DeepSeek Harness 的手机伴侣：手机 App（[aidock-app](https://github.com/xg-1-179/aidock-app)）通过六位连接码连上这台电脑，
直接在手机上看会话、发消息、打断回合。

本仓库派生自 MIT 许可的 [WNLUO/dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)，
保留它原有的中转 / 局域网 / tailcat 通道与协议 v2 端到端加密，只在配对入口上做了一处改动：
**手机只拿六位连接码也能完成协议 v2 的加密配对**（原本必须扫二维码里的票据）。

## 相对上游的改动

| 文件 | 改动 |
| --- | --- |
| `lib/routes/mobile-api.js` | 新增 `GET /api/mobile/v1/link/info`（公开的握手信息：实例号、名称、协议版本）；新增 `POST /api/mobile/v1/link/pair`，用请求头 `X-Aidock-Code` 里的六位连接码替换配对票据。 |
| `lib/mobile/pairing.js` | sealed 分支允许用 `body.code`（六位连接码）当票据材料，命中面板上的配对码才生效，否则按原有规则拒绝。 |

派生关系：`pairKey = HKDF-SHA256(ikm = utf8(连接码), salt = instanceId, info = "dsh-pair-v2", 32)`，
与二维码票据那条路的字节口径完全一致，配对回包同样加密。

## 安装

```bash
dsh plugin --profile <profile> add aidock
```

装好后在 DSH 的「设置 → 移动端」里打开配置页（或在浏览器直接开 `http://127.0.0.1:<port>/api/relay/panel`）。
面板上的六位数就是 App 要输入的连接码。

## 手机端

`https://github.com/xg-1-179/aidock-app/releases` 下载最新 APK，填写电脑地址（例如 `1.2.3.4:41873`）与六位连接码即可。
