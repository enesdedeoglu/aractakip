// config/settings.json okuyucu (eksik alanlar varsayılanlarla doldurulur)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  repo: null,
  agent: {
    intervalMinutes: 5,
    fullScanEveryMinutes: 60,
    // Ajanın doğrudan (tarayıcısız) taradığı kaynaklar. sahibinden, arabam ve Borusan
    // kullanıcının Chrome'undaki eklenti üzerinden gelir (bkz. extension).
    sources: ['otokoc'],
    minIntervals: {},
    // Eklenti sekmesinin sayfa açma aralıkları (dakika)
    extension: { sahibinden: 15, sahibindenFull: 1440, arabam: 5, arabamFull: 120, borusan: 10, gap: 0.75, crawlGap: 1 },
  },
  // Otokoç ve Borusan GitHub sunucularını engelliyor; Otokoç ara sıra açık olabilir diye denenir
  cloud: { sources: ['arabam', 'otokoc'] },
  // Bildirim filtresi: boş bırakılırsa tüm yeni Tesla ilanları bildirilir
  alerts: {
    models: [],
    maxPrice: null,
    maxKm: null,
    minYear: null,
    notifyPriceDrops: true,
    notifyRemoved: false,
    onlyLabels: [],
    excludeHeavyDamage: true, // ağır hasar kayıtlı ilanlar için mail gönderme
  },
};

// Yerel gizli ayarlar (SMTP şifresi vb.) ~/.aractakip/env dosyasından okunur: ANAHTAR=değer
let envLoaded = false;
export function loadLocalEnv() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.aractakip', 'env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* dosya yok */ }
}

export function loadSettings() {
  loadLocalEnv();
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8')); } catch { /* varsayılan */ }
  return {
    ...DEFAULTS,
    ...user,
    agent: { ...DEFAULTS.agent, ...(user.agent || {}), extension: { ...DEFAULTS.agent.extension, ...(user.agent?.extension || {}) } },
    cloud: { ...DEFAULTS.cloud, ...(user.cloud || {}) },
    alerts: { ...DEFAULTS.alerts, ...(user.alerts || {}) },
  };
}
