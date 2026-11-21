#!/usr/bin/env node
/**
 * AIDock 自检：把「手机能不能连上」这条路按 App 的调用顺序走一遍，出 PASS/FAIL 清单。
 *
 *   node tools/selftest.js                                  # 打本机 3080
 *   node tools/selftest.js --base http://101.43.213.201:41873
 *   node tools/selftest.js --base http://PUB --public-base http://PUB   # 顺带查公网安全边界
 *   node tools/selftest.js --send --stream                  # 真发一条消息、挂一次 SSE（会真的跑一轮）
 *
 * 退出码：0 = 全过；1 = 有 FAIL。
 *
 * 只依赖 node 自带模块（fetch / crypto），不需要 npm install。
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const BASE = (argOf('--base', 'http://127.0.0.1:3080') || '').replace(/\/+$/, '');
const PUBLIC_BASE = (argOf('--public-base', '') || '').replace(/\/+$/, '');
const CODE_ARG = argOf('--code', '');
const DO_SEND = argv.includes('--send');
const DO_STREAM = argv.includes('--stream');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const hkdf = (ikm, salt, info, n = 32) => Buffer.from(hkdfSync('sha256', ikm, salt, info, n));
const isLoopback = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? '  — ' + detail : ''}`);
  return ok;
}
function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(`SKIP  ${name}  — ${why}`);
}

/** 本机六位码：优先 --code，其次读 <DSH_HOME>/aidock-code.json，最后问本机面板。 */
async function resolveCode() {
  if (CODE_ARG) return CODE_ARG;
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.dsh', 'aidock-code.json'), 'utf8'));
    if (raw && /^\d{6}$/.test(String(raw.code || ''))) return String(raw.code);
  } catch {
    /* 没有文件就走网络取 */
  }
  try {
    const res = await fetch('http://127.0.0.1:3080/api/mobile/v1/link/code');
    const body = await res.json();
    if (body && /^\d{6}$/.test(String(body.code || ''))) return String(body.code);
  } catch {
    /* 下面统一报错 */
  }
  return '';
}

/** 一份会话密钥 + 带签名的 call()，与 App 的实现一一对应。 */
function makeClient({ instanceId, deviceKey, keyId, token, credential }) {
  const up = hkdf(deviceKey, Buffer.alloc(0), 'dsh-v2|up');
  const down = hkdf(deviceKey, Buffer.alloc(0), 'dsh-v2|down');
  const sig = hkdf(deviceKey, Buffer.alloc(0), 'dsh-v2|sig');

  // GET 空体也要签名（sha256 算「实际发出去的 0 字节」），SSE 挂流同样走这套头。
  function signEnvelope(method, path, query, sent) {
    const ts = Date.now();
    const nonce = randomBytes(12);
    const nonceB64 = b64u(nonce);
    const bodyHash = createHash('sha256').update(sent).digest('hex');
    const canonical = ['v2', method, path, query, String(ts), nonceB64, bodyHash].join('\n');
    const signature = createHmac('sha256', sig).update(canonical).digest('base64url');
    return { ts, nonce, nonceB64, headers: {
      'X-Dsh-Proto': '2',
      'X-Dsh-Key-Id': keyId,
      'X-Dsh-Ts': String(ts),
      'X-Dsh-Nonce': nonceB64,
      'X-Dsh-Sig': signature,
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-Dsh-Device-Credential': credential,
    } };
  }

  function authHeaders(method, path, query = '') {
    return signEnvelope(method, path, query, '').headers;
  }

  async function call(method, path, query = '', payload = {}) {
    const { ts, nonce, nonceB64, headers } = signEnvelope(method, path, query, '');
    const cipher = createCipheriv('aes-256-gcm', up, nonce);
    cipher.setAAD(Buffer.from(`v2|up|${method}|${path}`, 'utf8'));
    const sealed = Buffer.concat([
      nonce,
      cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const body = JSON.stringify({ v: 2, c: sealed.toString('base64') });
    const sent = method === 'GET' ? '' : body;
    // 签名要覆盖真正发出去的字节，POST 的哈希得按 body 重算一次。
    const signed = method === 'GET' ? { ts, nonceB64, headers } : signEnvelope(method, path, query, sent);
    const finalHeaders = method === 'GET' ? headers : signed.headers;
    const res = await fetch(BASE + path + query, {
      method,
      headers: finalHeaders,
      body: method === 'GET' ? undefined : sent,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: res.status, json: null, raw: text.slice(0, 160) };
    }
    const wire = json && json.env && typeof json.env === 'object' ? json.env : json;
    const downTs = method === 'GET' ? signed.ts : signed.ts;
    const downNonce = method === 'GET' ? nonceB64 : signed.nonceB64;
    if (wire && typeof wire.c === 'string' && typeof wire.n === 'string') {
      // 两段式信封：nonce(base64url) || ct+tag(base64)
      const plain = createDecipheriv('aes-256-gcm', down, Buffer.from(wire.n, 'base64url'));
      plain.setAAD(Buffer.from(`v2|down|${method}|${path}|${downTs}|${downNonce}`, 'utf8'));
      const all = Buffer.concat([Buffer.from(wire.n, 'base64url'), Buffer.from(wire.c, 'base64')]);
      plain.setAuthTag(all.subarray(all.length - 16));
      const plaintext = Buffer.concat([plain.update(all.subarray(12, all.length - 16)), plain.final()]).toString('utf8');
      const decoded = JSON.parse(plaintext);
      const merged = { ...json, ...decoded };
      delete merged.env;
      return { status: res.status, json: merged };
    }
    return { status: res.status, json };
  }

  return { call, up, down, sig, instanceId, authHeaders };
}

async function main() {
  console.log(`AIDock selftest  base=${BASE}${PUBLIC_BASE ? `  public=${PUBLIC_BASE}` : ''}\n`);

  // 1) 探活：公网口唯一无条件放行的端点，手机探活也用它。
  // 实例号以 /link/info 为准：/health 那条路由是插件早期一代注册的，热重载换不掉它，
  // 老宿主里它闭包中的 state.instanceId 会停在重启前那一代（实测踩过：拿它派生 pairKey 必 401）。
  const health = await fetch(BASE + '/api/mobile/v1/health').then((r) => r.json().catch(() => null));
  check('探活 /api/mobile/v1/health', !!health?.ok && health?.service === 'dsh-mobile-plugin', `service=${health?.service} apiVersion=${health?.apiVersion}`);

  // 2) link/info：手机配对前先问「你是谁、协议几版」。
  const infoRes = await fetch(BASE + '/api/mobile/v1/link/info');
  const info = await infoRes.json().catch(() => null);
  const instanceId = String(info?.instanceId || health?.instanceId || '');
  if (info?.instanceId && health?.instanceId && info.instanceId !== health.instanceId) {
    console.log(`  ! /health 的 instanceId 是旧值（${String(health.instanceId).slice(0, 8)} ≠ ${String(info.instanceId).slice(0, 8)}），已按 /link/info 走`);
  }
  check('配对入口 /api/mobile/v1/link/info', infoRes.status === 200 && info?.ok === true, `status=${infoRes.status} proto=${info?.proto} instanceId=${String(info?.instanceId || '').slice(0, 8)}`);

  // 3) 六位码页面只应本机能读。
  if (isLoopback(BASE)) {
    const panel = await fetch(BASE + '/api/mobile/v1/link/panel');
    check('本机六位码面板 /link/panel', panel.status === 200, `status=${panel.status} bytes=${(await panel.text()).length}`);
  } else {
    const panel = await fetch(BASE + '/api/mobile/v1/link/panel');
    check('公网口挡掉 /link/panel', panel.status === 403, `status=${panel.status}`);
    const codeRes = await fetch(BASE + '/api/mobile/v1/link/code');
    check('公网口挡掉 /link/code', codeRes.status === 403, `status=${codeRes.status}`);
    const qrRes = await fetch(BASE + '/api/mobile/v1/link/qr.svg?w=200');
    check('公网口挡掉 /link/qr.svg', qrRes.status === 403, `status=${qrRes.status}`);
  }

  // 4) 配对：pairKey 由六位码派生，AAD 绑 instanceId。
  const code = await resolveCode();
  if (!check('取到六位连接码', /^\d{6}$/.test(code), code ? `code=${code}` : '本机取不到（远端点请用 --code 指定）')) {
    return finish();
  }
  const pairKey = hkdf(Buffer.from(code, 'utf8'), Buffer.from(instanceId, 'utf8'), 'dsh-pair-v2');
  const deviceKey = randomBytes(32);
  const keyId = randomBytes(8).toString('hex');
  const clearText = JSON.stringify({
    deviceKey: b64u(deviceKey),
    keyId,
    device: { name: 'AIDock selftest', platform: 'android' },
  });
  const pn = randomBytes(12);
  const pCipher = createCipheriv('aes-256-gcm', pairKey, pn);
  pCipher.setAAD(Buffer.from(`pair|v2|${instanceId}`, 'utf8'));
  const sealed = b64u(Buffer.concat([pn, pCipher.update(Buffer.from(clearText, 'utf8')), pCipher.final(), pCipher.getAuthTag()]));
  const pairRes = await fetch(BASE + '/api/mobile/v1/link/pair2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aidock-Code': code },
    body: JSON.stringify({ instanceId, sealed }),
  });
  const pairBody = await pairRes.json().catch(() => null);
  if (!check('六位码配对 /link/pair2', pairRes.status === 200 && pairBody?.ok === true, `status=${pairRes.status}${pairBody?.error ? ' error=' + JSON.stringify(pairBody.error).slice(0, 90) : ''}`)) {
    return finish();
  }

  const grantRaw = Buffer.from(String(pairBody.sealed || ''), 'base64url');
  const gCipher = createDecipheriv('aes-256-gcm', pairKey, grantRaw.subarray(0, 12));
  gCipher.setAAD(Buffer.from(`pair|v2|${instanceId}`, 'utf8'));
  gCipher.setAuthTag(grantRaw.subarray(grantRaw.length - 16));
  const grant = JSON.parse(Buffer.concat([gCipher.update(grantRaw.subarray(12, grantRaw.length - 16)), gCipher.final()]).toString('utf8'));
  check('授权包可解封（token + 设备凭据）', !!grant.token && !!grant.deviceCredential, `perms=${(grant.permissions || []).length} expires=${grant.credentialExpiresAt ? Math.round((grant.credentialExpiresAt - Date.now()) / 86400000) + 'd' : '?'}`);

  const client = makeClient({ instanceId, deviceKey, keyId, token: grant.token, credential: grant.deviceCredential });

  // 5) 会话列表：列表类响应是「外层元数据 + env 内层信封」，要解两次。
  const sessions = await client.call('GET', '/api/mobile/v1/link/sessions', '?limit=5');
  const items = Array.isArray(sessions.json?.items) ? sessions.json.items : Array.isArray(sessions.json?.sessions) ? sessions.json.sessions : [];
  check('会话列表 /link/sessions（双层信封）', sessions.status === 200 && items.length > 0, `status=${sessions.status} items=${items.length} first=${JSON.stringify(items[0]?.title || '').slice(0, 30)}`);

  // 6) 历史消息：取最近一条会话的前几条。
  const firstId = items[0]?.sessionId || items[0]?.id || '';
  if (firstId) {
    const messages = await client.call('GET', '/api/mobile/v1/link/messages', `?sessionId=${encodeURIComponent(firstId)}&limit=5`);
    const rows = Array.isArray(messages.json?.messages) ? messages.json.messages : Array.isArray(messages.json?.items) ? messages.json.items : [];
    check('历史消息 /link/messages', messages.status === 200 && rows.length > 0, `status=${messages.status} rows=${rows.length} role=${rows[0]?.role || '?'}`);
  } else {
    skip('历史消息 /link/messages', '没有会话可取');
  }

  // 7) 模型快照：聊天页顶栏用的就是它。
  const models = await client.call('GET', '/api/mobile/v1/link/session/models', `?sessionId=${encodeURIComponent(firstId)}`);
  const current = models.json?.current || {};
  check('模型快照 /link/session/models', models.status === 200 && !!models.json?.ok, `status=${models.status} current=${current.provider || '?'}/${current.model || '?'}`);

  // 8) 可选：真的发一条（会跑一轮、消耗 token）。
  if (DO_SEND) {
    const created = await client.call('POST', '/api/mobile/v1/link/session/new', '', {});
    const sid = created.json?.sessionId || '';
    check('新建会话 /link/session/new', created.status === 200 && !!sid, `status=${created.status} session=${String(sid).slice(0, 22)}`);
    if (sid) {
      const sent = await client.call('POST', '/api/mobile/v1/link/session/send', '', { sessionId: sid, text: '只回复四个字：自检通过。' });
      check('发送消息 /link/session/send', sent.status === 200 && sent.json?.ok === true, `status=${sent.status} accepted=${sent.json?.accepted}`);
      if (DO_STREAM) {
        const ssePath = '/api/mobile/v1/link/session/stream';
        const sseQuery = `?sessionId=${encodeURIComponent(sid)}`;
        const sse = await fetch(BASE + ssePath + sseQuery, {
          headers: { ...client.authHeaders('GET', ssePath, sseQuery), Accept: 'text/event-stream' },
        });
        check('SSE 会话流可订阅 /link/session/stream', sse.status === 200, `status=${sse.status} type=${sse.headers.get('content-type') || '?'}`);
      }
    }
  } else {
    skip('新建会话 / 发消息 / SSE', '加 --send（和 --stream）才会真的跑一轮');
  }

  // 9) 可选：公网口安全边界（两份 base 都给时才跑）。
  if (PUBLIC_BASE) {
    const pubCode = await fetch(PUBLIC_BASE + '/api/mobile/v1/link/code');
    check('公网口挡掉 /link/code', pubCode.status === 403, `status=${pubCode.status}`);
    const pubInfo = await fetch(PUBLIC_BASE + '/api/mobile/v1/link/info');
    check('公网口放行 /link/info', pubInfo.status === 200, `status=${pubInfo.status}`);
  }

  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length) {
    console.log('失败项：' + failed.map((r) => r.name).join('、'));
    process.exitCode = 1;
  }
}

await main();
