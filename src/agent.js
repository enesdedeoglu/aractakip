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
import { fileURLToPath } from 'node:url';
import { runCycle } from './run.js';
import { loadSettings } from './settings.js';
import { closeContext } from './browser.js';
import { createBridge } from './bridge.js';
import { openStore } from './store.js';
import { notifyDesktop } from './notify.js';
import { log, sleep } from './util.js';

const LOCK = path.join(os.homedir(), '.aractakip', 'agent.lock');
const PORT = Number(process.env.AGENT_PORT || 5174);
// Bu ajanın adı: Mac'te "local", Android tablette (Termux) "tablet"
const RUNNER = process.env.ARACTAKIP_RUNNER || (process.platform === 'android' ? 'tablet' : 'local');

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
      const res = await runCycle({ sources: [], runner: RUNNER, extraScans: [{ ok: true, ...scan, runner: RUNNER }] });
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
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 12e6) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      json(202, {});
      bridge.page(msg).catch((e) => log('eklenti sayfa hatası:', e.message));
    });
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
    if (url === '/data/db.json') {
      if (!latestDb) { res.writeHead(503).end('veri henüz yüklenmedi'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(latestDb));
      return;
    }
    const file = path.join(WEB_DIR, url === '/' ? 'index.html' : path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('bulunamadı'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(buf);
    });
  });
  server.on('error', (e) => log('Arayüz sunucusu başlatılamadı:', e.message));
  server.listen(UI_PORT, '127.0.0.1', () => log(`Arayüz: http://127.0.0.1:${UI_PORT}`));
}

const lastRun = {};

async function main() {
  acquireLock();
  const stop = async () => { log('Ajan durduruluyor…'); await closeContext(); try { fs.unlinkSync(LOCK); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log(`Tesla ilan takip ajanı başladı (${RUNNER}).`);
  try { latestDb = (await openStore().load()).db; } catch (e) { log('Veri okunamadı:', e.message); }
  startServer();
  startUi();
  for (;;) {
    const { intervalMinutes, sources, minIntervals = {} } = loadSettings().agent;
    // Her kaynağın kendi en kısa tarama aralığı olabilir
    const due = sources.filter((s) => Date.now() - (lastRun[s] || 0) >= (minIntervals[s] ?? intervalMinutes) * 60000 - 5000);
    if (due.length) {
      await serial(async () => {
        const res = await runCycle({ mode: 'auto', sources: due, runner: RUNNER });
        if (res?.db) latestDb = res.db;
      });
      due.forEach((s) => { lastRun[s] = Date.now(); });
    }
    await sleep(30_000);
  }
}

main();
