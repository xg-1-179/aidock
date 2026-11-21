#!/usr/bin/env node
/**
 * AIDock 直连转发（模式 B）
 *
 * 把本机 DSH 网页/插件的 `127.0.0.1:<target>` 转发到 `0.0.0.0:<port>`，只做透明转发：
 * 不改 Host、不加鉴权 —— 鉴权仍由插件自己的移动 token 负责。
 *
 * 什么时候需要它：宿主的局域网代理（插件内置，端口 41873）在部分版本上会把手机请求
 * 统一挡成 401（凭据库与宿主进程不同步时），这时用这条纯转发绕开它。手机端体验不变，
 * 地址仍是 `http://<公网IP>:41873`。
 *
 * 用法：
 *   node tools/direct-forward.js                 # 默认 0.0.0.0:41873 → 127.0.0.1:3080
 *   PORT=41999 node tools/direct-forward.js      # 换端口
 *   TARGET=127.0.0.1:3080 node tools/direct-forward.js
 */
const http = require('node:http');
const net = require('node:net');

const LISTEN_PORT = Number(process.env.PORT || process.env.PROXY_PORT || 41873);
const TARGET = String(process.env.TARGET || '127.0.0.1:3080');
const at = TARGET.lastIndexOf(':');
const TARGET_HOST = TARGET.slice(0, at) || '127.0.0.1';
const TARGET_PORT = Number(TARGET.slice(at + 1));

// 逐跳头不能透传：透传后上游会以为连接语义变了。
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function cleanHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const proxy = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: cleanHeaders(req.headers),
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxy.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy error: ' + err.message);
  });
  // 手机端 SSE 长连接：上游断开时把下游也收掉，避免半开连接攒着。
  res.on('close', () => proxy.destroy());
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[aidock-direct] 0.0.0.0:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
});
