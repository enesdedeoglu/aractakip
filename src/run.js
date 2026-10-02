// Tek tarama döngüsü.  Kullanım:
//   node src/run.js [--mode=auto|quick|full] [--sources=arabam,otokoc] [--runner=local|cloud] [--dry]
import { pathToFileURL } from 'node:url';
import * as arabam from './sources/arabam.js';
import * as otokoc from './sources/otokoc.js';
import * as borusan from './sources/borusan.js';
import * as sahibinden from './sources/sahibinden.js';
import { openStore, ConflictError } from './store.js';
import { mergeScans, summarizeChanges, hasChanges, keyOf } from './merge.js';
import { buildAlert, sendAlerts } from './notify.js';
import { loadSettings } from './settings.js';
import { closeContext, interactive } from './browser.js';
import { log, sleep, BlockedError } from './util.js';

export const SOURCES = { arabam, otokoc, borusan, sahibinden };
const MIN = 60000;

async function scanSource(name, mode, db, runner) {
  const started = Date.now();
  try {
    const knownIds = new Set(Object.values(db.listings).filter((l) => l.source === name).map((l) => l.sourceId));
    const res = await SOURCES[name].scan({ mode, knownIds });
    // arabam: detay sayfasından hasar/boya/tramer (yalnızca yerelde, gerçek Chrome ile; yavaş tempo)
    if (name === 'arabam' && interactive()) {
      const need = res.listings.filter((l) => !db.listings[keyOf(l)]?.detailAt).slice(0, mode === 'full' ? 12 : 6);
      for (const l of need) {
        try {
          Object.assign(l, await arabam.fetchDetail(l), { detailAt: new Date().toISOString() });
        } catch (e) {
          log(`arabam detay hatası ${l.sourceId}: ${e.message}`);
          if (e instanceof BlockedError) break;
        }
        await sleep(3000 + Math.random() * 2000);
      }
    }
    log(`✓ ${name} (${mode}): ${res.listings.length} ilan, ${((Date.now() - started) / 1000).toFixed(0)} sn`);
    return { source: name, ok: true, listings: res.listings, complete: res.complete, mode, runner };
  } catch (e) {
    log(`✗ ${name}: ${e.message}`);
    return { source: name, ok: false, error: e.message, listings: [], complete: false, mode, runner };
  }
}

function pickMode(requested, name, db, fullEveryMin) {
  if (requested !== 'auto') return requested;
  const last = Date.parse(db.sources?.[name]?.lastFull || 0);
  return Date.now() - last > fullEveryMin * MIN ? 'full' : 'quick';
}

export async function runCycle({ mode = 'auto', sources, runner = 'local', dry = false, extraScans = [] } = {}) {
  const settings = loadSettings();
  const store = openStore();
  let { db, version } = await store.load();
  const fullEvery = runner === 'cloud' ? 55 : settings.agent.fullScanEveryMinutes;

  const scans = [];
  for (const name of sources) {
    if (!SOURCES[name]) { log(`Bilinmeyen kaynak: ${name}`); continue; }
    scans.push(await scanSource(name, pickMode(mode, name, db, fullEvery), db, runner));
  }
  scans.push(...extraScans);
  if (!scans.length) return null;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const firstTime = new Set(scans.filter((s) => s.ok && !db.sources?.[s.source]?.lastOk).map((s) => s.source));
    const okFlags = (d) => JSON.stringify(Object.entries(d.sources || {}).map(([k, v]) => [k, Object.entries(v.runs || {}).map(([r, x]) => [r, x.ok])]));
    const before = okFlags(db);
    const work = structuredClone(db);
    const changes = mergeScans(work, scans);
    const after = okFlags(work);
    const summary = summarizeChanges(changes) || 'değişiklik yok';
    log(`Sonuç: ${summary}`);
    if (dry) return { db: work, changes };

    const heartbeatDue = Date.now() - Date.parse(db.savedAt || 0) > 55 * MIN;
    if (store.kind === 'github' && !hasChanges(changes) && before === after && !heartbeatDue) {
      log('Kaydedilecek değişiklik yok.');
      return { db: work, changes };
    }
    work.savedAt = new Date().toISOString();
    try {
      await store.save(work, version, `veri: ${summary} [${scans.map((s) => s.source + (s.ok ? '' : '✗')).join(',')}] (${runner})`);
    } catch (e) {
      if (e instanceof ConflictError && attempt < 6) {
        log('Başka bir tarayıcı aynı anda yazdı, yeniden birleştiriliyor…');
        await sleep(1500 * attempt);
        ({ db, version } = await store.load());
        continue;
      }
      throw e;
    }

    if (process.env.GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(process.env.GITHUB_OUTPUT, 'saved=true\n');

    // İlk kez taranan kaynağın tüm ilanları "yeni" sayılmasın
    changes.added = changes.added.filter((k) => !firstTime.has(work.listings[k]?.source));
    if (firstTime.size) log(`İlk tarama (${[...firstTime].join(', ')}): toplu bildirim gönderilmedi.`);
    const alert = buildAlert(work, changes, settings.alerts);
    const sent = await sendAlerts(alert);
    if (sent.length) log(`Bildirim gönderildi: ${sent.join(', ')}`);
    return { db: work, changes };
  }
}

// Doğrudan çalıştırıldıysa
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));
  const settings = loadSettings();
  const runner = args.runner || (process.env.CI ? 'cloud' : 'local');
  const sources = args.sources ? String(args.sources).split(',') : runner === 'cloud' ? settings.cloud.sources : settings.agent.sources;
  runCycle({ mode: args.mode || 'auto', sources, runner, dry: !!args.dry })
    .then(() => closeContext())
    .then(() => process.exit(0))
    .catch(async (e) => { console.error(e); await closeContext(); process.exit(1); });
}
