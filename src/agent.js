// Yerel ajan: bilgisayar açıkken sürekli çalışır.
//  - sahibinden, arabam (km + hasar detayı) ve Borusan Next'i kullanıcının kendi Chrome'undaki
//    eklenti (extension/) üzerinden okur: eklenti tek bir sabitlenmiş sekmede sırayla sayfa açar
//  - Otokoç'u doğrudan HTTP ile çeker
//  - sonuçları bulutla aynı veri dosyasına yazar, değişiklikleri bildirir
//    npm run agent
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCycle } from './run.js';
import { loadSettings } from './settings.js';
import { closeContext } from './browser.js';
import { createBridge } from './bridge.js';
import { openStore } from './store.js';
import { setMailPause, DURATIONS } from './prefs.js';
import { publishSite } from './publish.js';
import { notifyDesktop } from './notify.js';
import { log, sleep, recentLog } from './util.js';

const LOCK = path.join(os.homedir(), '.aractakip', 'agent.lock');
const PORT = Number(process.env.AGENT_PORT || 5174);
// Bu ajanın adı: Mac'te "local", Android tablette (Termux) "tablet"
const RUNNER = process.env.ARACTAKIP_RUNNER || (process.platform === 'android' ? 'tablet' : 'local');
// Kod sürümü (son commit zamanı): siteyi tarayan cihaz eski koddaysa güncel cihaz devralır
const VERSION = (() => {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    return Number(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim()) || 0;
  } catch { return 0; }
})();

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); log(`Ajan zaten çalışıyor (pid ${pid}).`); process.exit(0); } catch { /* eski kilit */ }
    }
  } catch { /* kilit yok */ }
  fs.writeFileSync(LOCK, String(process.pid));
}

// Tek seferde tek döngü (tarama ve eklenti verisi aynı anda yazmasın)
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn).catch((e) => log('Döngü hatası:', e.message)));

let latestDb = null;
let lastChallengeNotice = 0;

const bridge = createBridge({
  intervals: loadSettings().agent.extension,
  runner: RUNNER,
  version: VERSION,
  primary: loadSettings().agent.primary,
  // Ortak kayıttaki zamanlama: başka cihaz taradıysa veya ajan yeniden başladıysa tekrar etme
  shared: (source) => latestDb?.sources?.[source] || {},
  onChallenge: (url, info = {}) => {
    const host = new URL(url).host.replace('www.', '');
    if (info.blocked) {
      notifyDesktop(`${host} erişimi engelledi`, `Siteye ${info.hours} saat boyunca hiç girilmeyecek; sonra otomatik devam edilir.`);
      return;
    }
    log(`doğrulama ekranı: ${host} (tarayıcıdaki takip sekmesinde)`);
    if (Date.now() - lastChallengeNotice > 30 * 60000) {
      lastChallengeNotice = Date.now();
      notifyDesktop(`${host} doğrulama istiyor`, 'Tarayıcıdaki Tesla İlan Takip sekmesinde doğrulamayı tamamlayın.');
    }
  },
  needDetail: () => Object.values(latestDb?.listings || {})
    .filter((l) => l.source === 'arabam' && l.status === 'active' && !l.detailAt)
    .sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen))
    .map((l) => l.url),
  onScan: (scan) => {
    log(`eklenti: ${scan.source} ${scan.mode} – ${scan.listings.length} ilan${scan.complete ? ' (tam)' : ''}`);
    return serial(async () => {
      const res = await runCycle({ sources: [], runner: RUNNER, codeVersion: VERSION, agentInfo, extraScans: [{ ok: true, ...scan, runner: RUNNER }] });
      if (res?.db) latestDb = res.db;
    });
  },
});

function startServer() {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    // Yalnızca tarayıcı eklentisinden gelen istekler
    if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) { res.writeHead(403).end(); return; }
    // Eklentinin izni tarayıcıca tanınmazsa (ör. Firefox) CORS ile de çalışsın
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    const json = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
    if (req.method === 'GET' && req.url === '/status') return json(200, { ok: true, ...bridge.status() });
    if (req.method === 'GET' && req.url === '/next') return json(200, { url: bridge.next() });
    if (req.method === 'POST' && req.url === '/log') {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); });
      req.on('end', () => { try { const m = JSON.parse(b); log(m.where === 'info' ? `eklenti: ${m.error}` : `eklenti hatası (${m.where}): ${m.error}`); } catch {} json(202, {}); });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/page') { res.writeHead(404).end(); return; }
    if (process.env.ARACTAKIP_DEBUG) {
      log(`/page isteği başladı: ${req.headers['content-length'] || '?'} bayt`);
      req.on('aborted', () => log('/page isteği yarıda kesildi'));
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 12e6) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch (e) { log(`eklenti sayfası okunamadı (${Math.round(body.length / 1024)} KB): ${e.message}`); res.writeHead(400).end(); return; }
      json(202, {});
      if (process.env.ARACTAKIP_DEBUG) log(`eklenti sayfası geldi: ${msg.kind || (msg.challenge ? 'doğrulama' : '?')} ${Math.round(body.length / 1024)} KB ${String(msg.url || '').slice(0, 80)}`);
      bridge.page(msg).catch((e) => log('eklenti sayfa hatası:', e.message));
    });
    req.on('error', (e) => log('eklenti isteği hatası:', e.message));
  });
  server.on('error', (e) => log('Eklenti sunucusu başlatılamadı:', e.message));
  server.listen(PORT, '127.0.0.1', () => log(`Eklenti uç noktası: http://127.0.0.1:${PORT}`));
}

// Web arayüzü: http://127.0.0.1:5173 (veri bellekteki güncel kayıttan sunulur)
const UI_PORT = Number(process.env.UI_PORT || 5173);
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function startUi() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    if (url === '/api/prefs' && req.method === 'GET') {
      // Mail ayarı başka yerden (GitHub/diğer cihaz) değişmiş olabilir: ortak kayıttan taze oku
      openStore().load().then(({ db }) => {
        if (latestDb) latestDb.prefs = db.prefs;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, prefs: db.prefs || {} }));
      }).catch((e) => res.writeHead(500).end(JSON.stringify({ ok: false, error: e.message })));
      return;
    }
    if (url === '/api/mail' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 1000) req.destroy(); });
      req.on('end', async () => {
        try {
          const { action, duration } = JSON.parse(b || '{}');
          const prefs = await serial(() => setMailPause(action === 'devam' ? 'devam' : 'durdur', duration || 'süresiz', RUNNER));
          if (latestDb) latestDb.prefs = prefs || (await openStore().load()).db.prefs;
          log(`Mail bildirimleri: ${action === 'devam' ? 'devam' : `durduruldu (${duration || 'süresiz'})`}`);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, prefs: latestDb?.prefs }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    if (url === '/data/db.json') {
      if (!latestDb) { res.writeHead(503).end('veri henüz yüklenmedi'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(latestDb));
      return;
    }
    const file = path.join(WEB_DIR, url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('bulunamadı'); return; }
      const body = file.endsWith('index.html') ? buf.toString().replace(/__BUILD__/g, String(Date.now())) : buf;
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    });
  });
  server.on('error', (e) => log('Arayüz sunucusu başlatılamadı:', e.message));
  server.listen(UI_PORT, '127.0.0.1', () => log(`Arayüz: http://127.0.0.1:${UI_PORT}`));
}

// Otomatik güncelleme (tablette): GitHub'da yeni kod varsa kapan; termux-run.sh kodu çekip yeniden başlatır
function startAutoUpdate() {
  if (process.env.ARACTAKIP_AUTOUPDATE !== '1') return;
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  setInterval(() => {
    execFile('git', ['-C', dir, 'fetch', '-q', 'origin', 'main'], (err) => {
      if (err) return;
      execFile('git', ['-C', dir, 'diff', '--quiet', 'HEAD', 'origin/main', '--', 'src', 'package.json', 'config'], (changed) => {
        if (!changed) return;
        log('Yeni kod bulundu, güncellemek için yeniden başlatılıyor…');
        serial(async () => { await closeContext(); try { fs.unlinkSync(LOCK); } catch {} process.exit(0); });
      });
    });
  }, 30 * 60000);
}

// Site yayını (GitHub Actions yerine): 2 dakikada bir dene; gh-pages en sık 6 dakikada bir güncellenir
function startSitePublisher() {
  const store = (() => { try { return openStore(); } catch { return null; } })();
  if (store?.kind !== 'github') return;
  let lastErr = '';
  const tick = () => serial(async () => {
    try {
      const r = await publishSite({ store });
      if (r.published) log(`Site yayınlandı (${r.commit.slice(0, 7)})`);
      lastErr = '';
    } catch (e) {
      if (e.message !== lastErr) log('Site yayınlanamadı:', e.message);
      lastErr = e.message;
    }
  });
  setTimeout(tick, 20_000);
  setInterval(tick, 2 * 60000);
}

// Sitedeki mail düğmesi (GitHub'da değilken) depo sahibinin açtığı "mail durdur 1 gün" / "mail devam"
// başlıklı bir issue oluşturur; ajan bunu uygulayıp issue'yu kapatır.
function startRemoteCommands() {
  const store = (() => { try { return openStore(); } catch { return null; } })();
  if (store?.kind !== 'github') return;
  const owner = store.repo.split('/')[0];
  const check = async () => {
    try {
      const res = await store.api(`/issues?state=open&creator=${owner}&per_page=20`);
      if (!res.ok) return;
      for (const is of await res.json()) {
        const m = !is.pull_request && is.author_association === 'OWNER' && is.title.trim().toLocaleLowerCase('tr-TR').match(/^mail\s+(durdur|devam)\s*(.*)$/);
        if (!m) continue;
        const action = m[1];
        const duration = Object.hasOwn(DURATIONS, m[2].trim()) ? m[2].trim() : 'süresiz';
        const prefs = await serial(() => setMailPause(action, duration, 'site'));
        if (latestDb && prefs) latestDb.prefs = prefs;
        const msg = action === 'devam' ? 'Mail bildirimleri yeniden başladı.' : `Mail bildirimleri durduruldu (${duration}).`;
        log(msg, `(issue #${is.number})`);
        await store.api(`/issues/${is.number}/comments`, { method: 'POST', body: JSON.stringify({ body: `✓ ${msg} (${RUNNER})` }) });
        await store.api(`/issues/${is.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
        await publishSite({ store, force: true }).catch(() => {});
      }
    } catch (e) { log('Mail komutu okunamadı:', e.message); }
  };
  setTimeout(check, 10_000);
  setInterval(check, 2 * 60000);
}

// Uzaktan tanı için ortak kayda yazılan özet
const agentInfo = () => ({ v: VERSION, platform: process.platform, bridge: bridge.status(), log: recentLog.slice(-25) });

const lastRun = {};

async function main() {
  acquireLock();
  const stop = async () => { log('Ajan durduruluyor…'); await closeContext(); try { fs.unlinkSync(LOCK); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`Tesla ilan takip ajanı başladı (${RUNNER}, sürüm ${new Date(VERSION * 1000).toISOString().slice(0, 16)}).`);
  try { latestDb = (await openStore().load()).db; } catch (e) { log('Veri okunamadı:', e.message); }
  startServer();
  startUi();
  startAutoUpdate();
  startSitePublisher();
  startRemoteCommands();
  for (;;) {
    const { intervalMinutes, sources, minIntervals = {} } = loadSettings().agent;
    // Her kaynağın kendi en kısa tarama aralığı olabilir
    const due = sources.filter((s) => Date.now() - (lastRun[s] || 0) >= (minIntervals[s] ?? intervalMinutes) * 60000 - 5000);
    if (due.length) {
      await serial(async () => {
        const res = await runCycle({ mode: 'auto', sources: due, runner: RUNNER, codeVersion: VERSION, agentInfo });
        if (res?.db) latestDb = res.db;
      });
      due.forEach((s) => { lastRun[s] = Date.now(); });
    }
    await sleep(30_000);
  }
}

main();
