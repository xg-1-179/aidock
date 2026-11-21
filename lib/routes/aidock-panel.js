// AIDock 连接码面板：把「六位码 + 打哪个地址」一次讲清楚，页面自己轮询续期。
//
// 这一页只在本机可读（调用方已核过 remoteAddress），交付的是「用户手机上要填的两格」：
// 电脑地址与连接码。宿主那边还有二维码/中转那条老路，AIDock 不用它——码是我们自己发的，
// 十分钟一换，页面上直接显示还剩多久。

const TTL_MS = 10 * 60 * 1000;

/** 面板/接口共用的载荷：码、剩余毫秒、实例、地址候选。 */
function panelPayload({ state = {}, code = '', at = 0, hosts = [], now = Date.now() } = {}) {
  const unique = [];
  for (const raw of hosts) {
    const url = String(raw || '').trim().replace(/\/+$/, '');
    if (url && !unique.includes(url)) unique.push(url);
  }
  return {
    ok: true,
    code: String(code || ''),
    expiresInMs: Math.max(0, Number(at || 0) + TTL_MS - now),
    instanceId: String((state && state.instanceId) || ''),
    hosts: unique,
  };
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 整页 HTML。第一屏就是「手机要填的两格」，下面说清怎么连。
 * 不引任何外链资源：这台机器在云上，页面必须离线也能开。
 */
function renderPanel(payload) {
  const code = escapeHtml(payload.code || '------');
  const hosts = Array.isArray(payload.hosts) ? payload.hosts : [];
  const hostRows = hosts.length
    ? hosts.map((h) => `<li><b>${escapeHtml(h)}</b></li>`).join('')
    : '<li class="dim">还没有可用的地址：请在插件设置里填「公网直连地址」</li>';
  const boot = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIDock 连接码</title>
<style>
  :root{--bg:#0B0F14;--surface:#141A21;--line:#1E2A36;--text:#E6EDF6;--dim:#8FA3B8;--accent:#4DA3FF}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);
    font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    display:flex;align-items:center;justify-content:center;padding:28px}
  .card{width:min(94vw,540px);background:var(--surface);border:1px solid var(--line);
    border-radius:22px;padding:28px 30px 24px}
  .eyebrow{font-size:11px;letter-spacing:.18em;color:var(--dim);text-transform:uppercase}
  h1{margin:10px 0 0;font-size:19px;font-weight:600}
  .code{margin:18px 0 6px;font-size:clamp(40px,11vw,64px);font-weight:650;line-height:1;
    letter-spacing:.14em;color:var(--accent);font-variant-numeric:tabular-nums}
  .meta{font-size:12.5px;color:var(--dim);line-height:1.7}
  .bar{height:3px;margin:16px 0 18px;border-radius:3px;background:#16202B;overflow:hidden}
  .bar>i{display:block;height:100%;background:var(--accent);width:100%;transition:width .4s linear}
  h2{margin:20px 0 8px;font-size:12px;font-weight:600;letter-spacing:.1em;color:var(--dim)}
  ul{margin:0;padding-left:18px;font-size:13.5px;line-height:1.85}
  li b{font-weight:500;color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .dim{color:var(--dim)}
  ol{margin:0;padding-left:18px;font-size:13px;line-height:1.9;color:var(--dim)}
  ol b{color:var(--text);font-weight:500}
  .qr{margin:2px 0 4px;display:flex;gap:16px;align-items:center}
  .qrbox{background:#fff;padding:8px;border-radius:10px;line-height:0}
  .qrhint{font-size:12.5px;line-height:1.7;color:var(--dim)}
  .qrhint b{color:var(--text);font-weight:500}
  .foot{margin-top:20px;padding-top:14px;border-top:1px solid var(--line);font-size:11.5px;color:#5E7183}
</style>
<div class="card">
  <div class="eyebrow">AIDock · 连接码</div>
  <h1>在手机上填这两项</h1>
  <div class="code" id="code">${code}</div>
  <div class="meta" id="meta">正在读取有效期…</div>
  <div class="bar"><i id="bar"></i></div>
  <div class="qr">
    <div class="qrbox"><img id="qr" width="176" height="176" alt="连接二维码" src="/api/mobile/v1/link/qr.svg?w=352"></div>
    <div class="qrhint">
      <b>手机扫这张码</b><br>
      地址和六位码一起带过去，不用手输。<br>
      码十分钟一换，本页会自动刷新。
    </div>
  </div>
  <h2>电脑地址</h2>
  <ul>${hostRows}</ul>
  <h2>怎么连</h2>
  <ol>
    <li>手机装 <b>AIDock</b>（GitHub Releases 里的 APK）。</li>
    <li>地址填上面那条<b>公网</b>地址，端口别改。</li>
    <li>输入六位码，点连接。码十分钟一换，过期就刷新本页。</li>
  </ol>
  <div class="foot">实例 ${escapeHtml(payload.instanceId || '')} · 本页只在本机可打开</div>
</div>
<script>
  var boot = ${boot};
  var codeEl = document.getElementById('code');
  var metaEl = document.getElementById('meta');
  var barEl = document.getElementById('bar');
  var qrEl = document.getElementById('qr');
  var lastCode = '';
  function paint(p){
    if(!p || !p.ok) return;
    codeEl.textContent = p.code || '------';
    var s = Math.max(0, Math.round((p.expiresInMs||0)/1000));
    var m = Math.floor(s/60), r = s%60;
    metaEl.textContent = s>0 ? ('还剩 '+m+' 分 '+r+' 秒，过期自动换新码') : '已过期，正在换新码…';
    barEl.style.width = Math.max(0, Math.min(100, (p.expiresInMs||0)/600000*100)) + '%';
    if (qrEl && p.code && p.code !== lastCode) {
      lastCode = p.code;
      qrEl.src = '/api/mobile/v1/link/qr.svg?w=352&t=' + Date.now();
    }
  }
  paint(boot);
  function tick(){
    fetch('/api/mobile/v1/link/code', {cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(paint)
      .catch(function(){});
  }
  setInterval(tick, 20000);
</script>
</html>`;
}

module.exports = { TTL_MS, panelPayload, renderPanel };
