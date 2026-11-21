# 直连转发（模式 B）

宿主的「局域网直连」跑在 **sidecar 子进程**里（`lib/relay/lan-proxy.js`），它自己维护一份
凭据库。插件热重载换代后，sidecar 那份凭据库可能与宿主不同步：公网口上配对能成功（因为
`/link/pair` 在免鉴权白名单里），但之后每个带凭据的请求都被回 **401 `缺少或无效的移动
token`**，而同一份凭据打 `127.0.0.1:3080` 完全正常。

这时不必等插件修：把 41873 让给一条纯转发，手机端地址不变，鉴权仍由宿主自己做。

## 一、关掉 sidecar 的监听

```bash
curl -X POST http://127.0.0.1:3080/api/relay/config \
     -H 'Content-Type: application/json' -d '{"lanEnabled":false}'
```

确认端口已空（只剩 TIME_WAIT）：

```bash
netstat -ano | findstr :41873
```

## 二、起转发

```bash
# 默认 0.0.0.0:41873 -> 127.0.0.1:3080
node tools/direct-forward.js

# 换端口 / 换目标
PORT=41999 node tools/direct-forward.js
TARGET=127.0.0.1:3080 PORT=41873 node tools/direct-forward.js
```

转发是透明的：不改 `Host`、不注入任何鉴权头，HTTP 与 WebSocket 升级都透传，SSE 长连接
靠 `res.on('close')` 收尾。

## 三、开机自启（Windows）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-direct-task.ps1
```

会注册计划任务 `AIDockDirectForward`（登录时启动、失败重试 3 次），日志写到
`%USERPROFILE%\Desktop\aidock-direct.log`。卸载：

```powershell
Unregister-ScheduledTask -TaskName AIDockDirectForward -Confirm:$false
```

## 四、安全组

腾讯云/阿里云的安全组要放行同一端口（TCP，来源 `0.0.0.0/0` 或你的运营商网段）。
本机 Windows 防火墙默认不拦（三档 profile 全 OFF）。

## 五、验证

```bash
curl http://<公网IP>:41873/api/mobile/v1/health
# {"ok":true,"service":"dsh-mobile-plugin",...}

curl http://<公网IP>:41873/api/mobile/v1/link/info
# {"ok":true,"service":"aidock","proto":2,"instanceId":"...","transport":"direct"}
```

两个都 200，就说明手机可以直连了：App 里填 `http://<公网IP>:41873`，再输入电脑上面板显示的
六位码。
