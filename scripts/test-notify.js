// Bildirim testi: en iyi 3 ilanla örnek bildirim üretir.
// SMTP/ntfy/Telegram ayarlıysa gerçekten gönderir; değilse e-posta önizlemesini dosyaya yazar.
//   node scripts/test-notify.js
import fs from 'node:fs';
import { openStore } from '../src/store.js';
import { loadSettings } from '../src/settings.js';
import { buildAlert, sendAlerts, emailHtml, subjectOf } from '../src/notify.js';

loadSettings();
const { db } = await openStore().load();
const top = Object.values(db.listings).filter((l) => l.status === 'active').sort((a, b) => b.a.score - a.a.score).slice(0, 3);
const drop = Object.values(db.listings).find((l) => l.status === 'active' && l.price);
const changes = { added: top.map((l) => l.key), priceChanged: drop ? [{ key: drop.key, from: drop.price + 75000, to: drop.price }] : [], removed: [], returned: [] };
const alert = buildAlert(db, changes, { ...loadSettings().alerts, models: [], maxPrice: null, maxKm: null, minYear: null, onlyLabels: [] });
const out = new URL('../data/mail-preview.html', import.meta.url);
fs.writeFileSync(out, `<title>${subjectOf(alert)}</title>${emailHtml(alert)}`);
console.log('Konu:', subjectOf(alert));
console.log('Önizleme:', out.pathname);
const sent = await sendAlerts(alert);
console.log(sent.length ? `Gönderildi: ${sent.join(', ')}` : 'Gönderim kanalı ayarlı değil (MAIL_TO/SMTP_USER/SMTP_PASS, NTFY_TOPIC veya TELEGRAM_*).');
