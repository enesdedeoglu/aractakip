// Bildirimler: e-posta (SMTP), ntfy.sh, Telegram, macOS masaüstü.
// Kimlik bilgileri yalnızca ortam değişkenlerinden / GitHub Secrets'tan okunur.
//   MAIL_TO, SMTP_USER, SMTP_PASS (Gmail uygulama şifresi), SMTP_HOST (vars: smtp.gmail.com), SMTP_PORT (vars: 465)
//   NTFY_TOPIC (opsiyonel), TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (opsiyonel)
//   SITE_URL: web arayüzünün adresi (e-postadaki bağlantı için)
import { execFile } from 'node:child_process';
import { log } from './util.js';

const SOURCE_NAMES = { arabam: 'arabam.com', sahibinden: 'sahibinden', otokoc: 'Otokoç 2. El', borusan: 'Borusan Next' };
const LABEL_EMOJI = { 'Fırsat': '🔥', 'İyi fiyat': '👍', 'Piyasa': '⚖️', 'Pahalı': '💸', 'Şüpheli': '⚠️' };

const tl = (n) => (n == null ? '-' : `${Math.round(n).toLocaleString('tr-TR')} TL`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function passesAlertFilter(l, alerts) {
  if (!l) return false;
  if (alerts.models?.length && !alerts.models.includes(l.c?.model)) return false;
  if (alerts.maxPrice && l.price > alerts.maxPrice) return false;
  if (alerts.maxKm && l.km > alerts.maxKm) return false;
  if (alerts.minYear && l.year < alerts.minYear) return false;
  if (alerts.onlyLabels?.length && !alerts.onlyLabels.includes(l.a?.label)) return false;
  if (alerts.excludeHeavyDamage && l.c?.heavy === 'var') return false;
  return true;
}

/** Bildirilecek olayları seç */
export function buildAlert(db, changes, alerts) {
  const get = (k) => db.listings[k];
  // Tam taramada ilk kez görülen eski ilanlar "yeni" sayılmasın: yayın tarihi son 3 gün olmalı
  const recent = (l) => !l.publishedAt || Date.now() - Date.parse(l.publishedAt) < 3 * 86400000;
  // Zaten bilinen bir aracın başka sitede de ilana çıkması "yeni araç" değildir
  const knownCar = (l) => l.dup && l.dup.members.some((k) => k !== l.key && db.listings[k] && Date.parse(db.listings[k].firstSeen) < Date.parse(l.firstSeen));
  const added = [...changes.added.map(get).filter((l) => l && recent(l) && !knownCar(l)), ...changes.returned.map(get)]
    .filter((l) => passesAlertFilter(l, alerts))
    .sort((a, b) => (b.a?.score ?? 0) - (a.a?.score ?? 0));
  const prices = alerts.notifyPriceDrops
    ? changes.priceChanged.map((c) => ({ ...c, l: get(c.key) })).filter((c) => c.l && passesAlertFilter(c.l, alerts))
    : [];
  const removed = alerts.notifyRemoved ? changes.removed.map(get).filter((l) => passesAlertFilter(l, alerts)) : [];
  return { added, prices, removed, db, empty: !added.length && !prices.length && !removed.length };
}

function line(l) {
  return `${LABEL_EMOJI[l.a?.label] || ''} ${l.c?.model} ${l.c?.trim} ${l.year || ''} · ${l.km != null ? l.km.toLocaleString('tr-TR') + ' km' : ''} · ${tl(l.price)} (${l.a?.label}${l.a?.deviation != null ? `, ${(l.a.deviation * 100).toFixed(0)}%` : ''}) · ${SOURCE_NAMES[l.source]}`;
}

export function subjectOf(alert) {
  const parts = [];
  if (alert.added.length) {
    const best = alert.added[0];
    parts.push(alert.added.length === 1
      ? `Yeni Tesla: ${best.c.model} ${best.year} ${tl(best.price)} (${best.a.label})`
      : `${alert.added.length} yeni Tesla ilanı`);
  }
  const drops = alert.prices.filter((p) => p.to < p.from);
  if (drops.length) parts.push(`${drops.length} fiyat düşüşü`);
  if (alert.prices.length - drops.length) parts.push(`${alert.prices.length - drops.length} fiyat artışı`);
  if (alert.removed.length) parts.push(`${alert.removed.length} ilan kalktı`);
  return `🚗 ${parts.join(' · ')}`;
}

function otherSites(l, db) {
  if (!l.dup || !db) return '';
  const others = l.dup.members.filter((k) => k !== l.key).map((k) => db.listings[k]).filter(Boolean);
  if (!others.length) return '';
  return `<div style="margin-top:4px;font-size:12px;color:#555">Aynı araç: ${others.map((o) =>
    `<a href="${esc(o.url)}" style="color:#2f6fdb">${esc(SOURCE_NAMES[o.source])} ${tl(o.price)}</a>`).join(' · ')}</div>`;
}

function card(l, extra = '', db = null) {
  const a = l.a || {};
  const color = { 'Fırsat': '#0a7d32', 'İyi fiyat': '#2f6fdb', 'Piyasa': '#666', 'Pahalı': '#b35900', 'Şüpheli': '#c0182b' }[a.label] || '#666';
  return `
  <tr><td style="padding:12px 0;border-bottom:1px solid #eee">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      ${l.image ? `<td width="132" valign="top"><a href="${esc(l.url)}"><img src="${esc(l.image)}" width="120" style="border-radius:8px;display:block" alt=""></a></td>` : ''}
      <td valign="top" style="font-family:Arial,sans-serif;font-size:14px;color:#222">
        <div><a href="${esc(l.url)}" style="color:#111;font-weight:bold;text-decoration:none">${esc(l.c?.model)} ${esc(l.c?.generation)} ${esc(l.c?.trim)} · ${l.year || ''}</a></div>
        <div style="margin:4px 0;font-size:18px;font-weight:bold">${tl(l.price)} ${extra}</div>
        <div style="color:#555">${[l.km != null ? l.km.toLocaleString('tr-TR') + ' km' : 'km ?', l.city, SOURCE_NAMES[l.source], l.sellerType].filter(Boolean).map(esc).join(' · ')}</div>
        <div style="margin-top:6px"><span style="background:${color};color:#fff;border-radius:10px;padding:2px 8px;font-size:12px">${esc(a.label)} · ${a.score}/100</span>
        ${a.expected ? `<span style="color:#555;font-size:12px"> beklenen ≈ ${tl(a.expected)} (${a.deviation > 0 ? '+' : ''}${(a.deviation * 100).toFixed(1)}%)</span>` : ''}</div>
        <div style="margin-top:6px;color:#333">${esc(a.advice)}</div>
        ${(a.cautions || []).length ? `<div style="margin-top:4px;color:#b35900;font-size:12px">⚠ ${a.cautions.map(esc).join('<br>⚠ ')}</div>` : ''}
        ${(a.reasons || []).length ? `<div style="margin-top:4px;color:#0a7d32;font-size:12px">✓ ${a.reasons.slice(0, 4).map(esc).join('<br>✓ ')}</div>` : ''}
        ${otherSites(l, db)}
      </td></tr></table>
  </td></tr>`;
}

export function emailHtml(alert) {
  const site = process.env.SITE_URL;
  const sec = (title, rows) => rows ? `<h3 style="font-family:Arial,sans-serif;margin:20px 0 4px">${title}</h3><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : '';
  return `<div style="max-width:640px;margin:auto">
    <h2 style="font-family:Arial,sans-serif">Tesla İlan Takip</h2>
    ${sec(`Yeni ilanlar (${alert.added.length})`, alert.added.map((l) => card(l, '', alert.db)).join(''))}
    ${sec(`Fiyat değişimleri (${alert.prices.length})`, alert.prices.map((p) => card(p.l, `<span style="font-size:13px;color:${p.to < p.from ? '#0a7d32' : '#c0182b'}">(${p.to < p.from ? '▼' : '▲'} ${tl(Math.abs(p.to - p.from))}, önce ${tl(p.from)})</span>`, alert.db)).join(''))}
    ${sec(`Kalkan ilanlar (${alert.removed.length})`, alert.removed.map((l) => card(l, '<span style="font-size:13px;color:#666">(satıldı / kaldırıldı)</span>')).join(''))}
    ${site ? `<p style="font-family:Arial,sans-serif"><a href="${esc(site)}">Tüm ilanları ve piyasa analizini aç →</a></p>` : ''}
    <p style="font-family:Arial,sans-serif;color:#999;font-size:11px">Fiyat tahminleri ilan verilerine dayanan istatistiksel bir modeldir; yatırım tavsiyesi değildir. Ekspertiz yaptırmadan araç almayın.</p>
  </div>`;
}

function emailText(alert) {
  const out = [];
  if (alert.added.length) out.push('YENİ İLANLAR', ...alert.added.map((l) => `${line(l)}\n  ${l.a.advice}\n  ${l.url}`));
  if (alert.prices.length) out.push('', 'FİYAT DEĞİŞİMLERİ', ...alert.prices.map((p) => `${tl(p.from)} → ${tl(p.to)} | ${line(p.l)}\n  ${p.l.url}`));
  if (alert.removed.length) out.push('', 'KALKAN İLANLAR', ...alert.removed.map((l) => `${line(l)}`));
  if (process.env.SITE_URL) out.push('', process.env.SITE_URL);
  return out.join('\n');
}

async function sendEmail(alert) {
  const { MAIL_TO, SMTP_USER, SMTP_PASS } = process.env;
  if (!MAIL_TO || !SMTP_USER || !SMTP_PASS) return false;
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(process.env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({
    from: `"Tesla İlan Takip" <${SMTP_USER}>`,
    to: MAIL_TO,
    subject: subjectOf(alert),
    text: emailText(alert),
    html: emailHtml(alert),
  });
  return true;
}

async function sendNtfy(alert) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return false;
  const first = alert.added[0] || alert.prices[0]?.l;
  await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: {
      // HTTP başlıkları Latin-1 olmalı; ntfy RFC 2047 kodlu UTF-8 başlığı destekler
      Title: `=?UTF-8?B?${Buffer.from(subjectOf(alert)).toString('base64')}?=`,
      Tags: 'car',
      Priority: alert.added.some((l) => l.a?.label === 'Fırsat') ? 'high' : 'default',
      ...(first ? { Click: first.url } : {}),
    },
    body: emailText(alert).slice(0, 3500),
  });
  return true;
}

async function sendTelegram(alert) {
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!tok || !chat) return false;
  const text = `${subjectOf(alert)}\n\n${emailText(alert)}`.slice(0, 4000);
  await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }),
  });
  return true;
}

export function notifyDesktop(title, message) {
  if (process.env.CI) return;
  if (process.platform === 'android') {
    // Termux:API kuruluysa Android bildirimi
    execFile('termux-notification', ['--title', title, '--content', message, '--sound'], () => {});
    return;
  }
  if (process.platform !== 'darwin') return;
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`;
  execFile('osascript', ['-e', script], () => {});
}

export async function sendAlerts(alert) {
  if (alert.empty) return [];
  const sent = [];
  for (const [name, fn] of [['e-posta', sendEmail], ['ntfy', sendNtfy], ['telegram', sendTelegram]]) {
    try { if (await fn(alert)) sent.push(name); }
    catch (e) { log(`Bildirim hatası (${name}):`, e.message); }
  }
  const first = alert.added[0];
  notifyDesktop(subjectOf(alert).replace('🚗 ', ''), first ? line(first) : `${alert.prices.length} fiyat değişimi`);
  return sent;
}
