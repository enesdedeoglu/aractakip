// Yerel ajan: bilgisayar açıkken sürekli çalışır.
//  - arabam (km + hasar detayı), Otokoç, Borusan Next'i gerçek Chrome ile tarar
//  - sahibinden verisini Chrome eklentisinden (extension/) 127.0.0.1:5174 üzerinden alır
//  - sonuçları bulutla aynı veri dosyasına yazar, değişiklikleri bildirir
//    npm run agent
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runCycle } from './run.js';
import { loadSettings } from './settings.js';
import { closeContext } from './browser.js';
import { normalize as normalizeSahibinden } from './sources/sahibinden.js';
import { notifyDesktop } from './notify.js';
import { log, sleep } from './util.js';

const LOCK = path.join(os.homedir(), '.aractakip', 'agent.lock');
const PORT = Number(process.env.AGENT_PORT || 5174);

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

let lastChallengeNotice = 0;
let lastIngest = null;

function startServer() {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    // Yalnızca tarayıcı eklentisinden ve yerelden gelen istekler
    if (origin && !origin.startsWith('chrome-extension://')) { res.writeHead(403).end(); return; }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, lastIngest }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/ingest') { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 8e6) req.destroy(); });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      res.writeHead(202).end('{}');
      if (msg.type === 'challenge') {
        if (Date.now() - lastChallengeNotice > 30 * 60000) {
          lastChallengeNotice = Date.now();
          notifyDesktop('sahibinden doğrulama istiyor', 'Chrome\'daki sahibinden sekmesinde "Devam Et"e basın.');
        }
        log('sahibinden: doğrulama ekranı (kullanıcının Chrome\'unda)');
        return;
      }
      if (msg.type !== 'scan') return;
      const listings = normalizeSahibinden(msg.pages || []);
      const rows = (msg.pages || []).reduce((n, p) => n + (p.rows?.length || 0), 0);
      if (rows && !listings.length) log('sahibinden: satırlar ayrıştırılamadı, örnek:', JSON.stringify(msg.pages[0]?.rows?.[0]).slice(0, 600), 'başlıklar:', msg.pages[0]?.heads);
      // Tam tarama ancak toplamın büyük kısmı geldiyse "tam" sayılır (yanlışlıkla kaldırma olmasın)
      const complete = !!msg.complete && (!msg.total || listings.length >= msg.total * 0.9);
      lastIngest = { at: new Date().toISOString(), count: listings.length, complete };
      log(`sahibinden (eklenti): ${listings.length} ilan${complete ? ' (tam tarama)' : ''}`);
      serial(() => runCycle({
        sources: [],
        runner: 'local',
        extraScans: [{ source: 'sahibinden', ok: true, listings, complete, mode: complete ? 'full' : 'quick', runner: 'local' }],
      }));
    });
  });
  server.on('error', (e) => log('Eklenti sunucusu başlatılamadı:', e.message));
  server.listen(PORT, '127.0.0.1', () => log(`Eklenti uç noktası: http://127.0.0.1:${PORT}`));
}

const lastRun = {};

async function main() {
  acquireLock();
  const stop = async () => { log('Ajan durduruluyor…'); await closeContext(); try { fs.unlinkSync(LOCK); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log('Tesla ilan takip ajanı başladı.');
  startServer();
  for (;;) {
    const { intervalMinutes, sources, minIntervals = {} } = loadSettings().agent;
    // Her kaynağın kendi en kısa tarama aralığı olabilir
    const due = sources.filter((s) => Date.now() - (lastRun[s] || 0) >= (minIntervals[s] ?? intervalMinutes) * 60000 - 5000);
    if (due.length) {
      await serial(() => runCycle({ mode: 'auto', sources: due, runner: 'local' }));
      due.forEach((s) => { lastRun[s] = Date.now(); });
    }
    await sleep(30_000);
  }
}

main();
