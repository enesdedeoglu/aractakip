// Gerçek Chrome ile sayfa açma (sahibinden, Borusan Next gibi tarayıcı doğrulaması isteyen siteler için).
// Gizlenme/atlatma hilesi YOKTUR: normal bir Chrome penceresidir. Site bir doğrulama ekranı
// gösterirse ("Devam Et" vb.) bunu kullanıcı kendisi tamamlar; program yalnızca bekler.
import os from 'node:os';
import path from 'node:path';
import { BlockedError, sleep, log } from './util.js';

let ctxPromise = null;

export const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(os.homedir(), '.aractakip', 'chrome-profile');

export function interactive() {
  return !process.env.CI && process.env.HEADLESS !== '1';
}

export async function getContext() {
  if (ctxPromise) return ctxPromise;
  ctxPromise = (async () => {
    let pw;
    try {
      pw = await import('playwright-core');
    } catch {
      throw new Error('playwright-core kurulu değil (npm install)');
    }
    const ctx = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: !interactive(),
      viewport: { width: 1280, height: 860 },
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
    });
    ctx.on('close', () => { ctxPromise = null; });
    return ctx;
  })();
  try {
    return await ctxPromise;
  } catch (e) {
    ctxPromise = null;
    throw e;
  }
}

export async function closeContext() {
  if (!ctxPromise) return;
  const ctx = await ctxPromise.catch(() => null);
  ctxPromise = null;
  await ctx?.close().catch(() => {});
}

/**
 * Sayfayı açar; doğrulama ekranı görünürse kendiliğinden geçmesini, etkileşimli modda ise
 * kullanıcının tamamlamasını bekler.
 * @param {(page)=>Promise<boolean>} isChallenge
 */
export async function openPage(url, { isChallenge, onChallenge, waitUserMs = 5 * 60_000 } = {}) {
  const ctx = await getContext();
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(1500);
  const blocked = async () => {
    const title = await page.title().catch(() => '');
    if (/just a moment|bir dakika|yükleniyor/i.test(title)) return true;
    return isChallenge ? isChallenge(page).catch(() => false) : false;
  };
  if (!(await blocked())) return page;

  // Otomatik (JS) doğrulamalar birkaç saniyede kendiliğinden geçer
  for (let i = 0; i < 15 && (await blocked()); i++) await sleep(1000);
  if (!(await blocked())) return page;

  if (!interactive()) throw new BlockedError(`${new URL(url).host}: tarayıcı doğrulaması gerekiyor`);

  log(`⚠️  ${new URL(url).host} doğrulama istiyor – açılan Chrome penceresinde doğrulamayı tamamlayın.`);
  await page.bringToFront().catch(() => {});
  onChallenge?.();
  const until = Date.now() + waitUserMs;
  while (Date.now() < until) {
    await sleep(2000);
    if (!(await blocked())) {
      await sleep(1500);
      // Doğrulamadan sonra site ana sayfaya atabilir; hedefe tekrar git
      if (!page.url().startsWith(url.split('?')[0])) await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (!(await blocked())) return page;
    }
  }
  throw new BlockedError(`${new URL(url).host}: doğrulama ${Math.round(waitUserMs / 60000)} dk içinde tamamlanmadı`);
}
