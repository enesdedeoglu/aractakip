// Ortak yardımcılar: HTTP, sayı/tarih ayrıştırma, bekleme.

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
  }
}

export async function fetchText(url, { retries = 2, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
          ...headers,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      if (res.status === 403 || res.status === 429 || /<title>Just a moment/i.test(text)) {
        throw new BlockedError(`${new URL(url).host} erişimi engelledi (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return { text, url: res.url };
    } catch (e) {
      lastErr = e;
      if (e instanceof BlockedError) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/** "2.250.000 TL" -> 2250000 */
export function parseNumber(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const digits = String(s).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

const TR_MONTHS = {
  ocak: 0, şubat: 1, subat: 1, mart: 2, nisan: 3, mayıs: 4, mayis: 4, haziran: 5,
  temmuz: 6, ağustos: 7, agustos: 7, eylül: 8, eylul: 8, ekim: 9, kasım: 10, kasim: 10, aralık: 11, aralik: 11,
};

/** "02 Ekim 2026" -> ISO tarih (gün başı, TR saati) */
export function parseTrDate(s) {
  if (!s) return null;
  const m = String(s).trim().toLocaleLowerCase('tr-TR').match(/(\d{1,2})\s+([a-zçğıöşü]+)\s+(\d{4})/);
  if (!m) return null;
  const month = TR_MONTHS[m[2]];
  if (month == null) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]), 9, 0, 0)).toISOString();
}

export const nowIso = () => new Date().toISOString();

export function log(...args) {
  console.log(`[${new Date().toLocaleTimeString('tr-TR')}]`, ...args);
}
