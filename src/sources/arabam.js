// arabam.com – düz HTTP ile çalışır (bulutta da).
// Not: /ikinci-el/otomobil/tesla adresi arabam tarafında yönlendirme döngüsüne giriyor;
// bu yüzden "tesla" metin araması kullanılıyor ve satırlar model adına göre süzülüyor.
import * as cheerio from 'cheerio';
import { fetchText, parseNumber, parseTrDate, sleep, log } from '../util.js';
import { openPage, interactive } from '../browser.js';

const BASE = 'https://www.arabam.com';

// Tembel yüklenen görseller data-src'de; kart için daha büyük boyutu kullan
function bigImage(src) {
  if (!src || /noImage/i.test(src)) return null;
  return src.replace(/_\d+x\d+\.jpg$/, '_580x435.jpg');
}

// Tek satırın yapısal hali (sayfada eklenti tarafından ya da burada cheerio ile çıkarılır)
//   { id, href, modelName, title, cells: string[], priceText, locs: string[], image }
function rowToListing(r) {
  if (!/^tesla\b/i.test(r.modelName || '')) return null; // metin aramasında çıkan alakasız ilanlar
  const cells = (r.cells || []).map((c) => String(c).replace(/\s+/g, ' ').trim());
  const href = r.href || '';
  const dateCell = cells.find((c) => /\d{1,2}\s+\S+\s+\d{4}$/.test(c));
  const sellerSlug = (href.match(/^\/ilan\/([a-z-]+?)-satilik-/) || [])[1] || '';
  return {
    source: 'arabam',
    sourceId: String(r.id),
    url: BASE + href,
    title: (r.title || '').trim(),
    modelRaw: r.modelName.trim(),
    year: Number(cells.find((c) => /^(19|20)\d{2}$/.test(c))) || null,
    km: parseNumber(cells.find((c) => /^[\d.]+\s*KM$/i.test(c))),
    price: parseNumber(r.priceText),
    city: r.locs?.[0] || null,
    district: r.locs?.[1] || null,
    sellerType: sellerSlug === 'sahibinden' ? 'sahibinden' : sellerSlug === 'yetkili-bayiden' ? 'yetkili' : 'galeri',
    image: bigImage(r.image),
    publishedAt: parseTrDate(dateCell),
    needsDetail: true,
  };
}

/** Eklentinin sayfada çıkardığı satırlar (küçük veri) */
export function fromRows(rows) {
  const listings = (rows || []).map(rowToListing).filter(Boolean);
  return { listings, rowCount: (rows || []).length };
}

export function parseList(html) {
  const $ = cheerio.load(html);
  const rows = $('tr.listing-list-item[id^="listing"]').map((_, tr) => {
    const row = $(tr);
    const img = row.find('img.listing-image');
    return {
      id: row.attr('data-imp-id') || row.attr('id').replace('listing', ''),
      href: row.find('a[href^="/ilan/"]').first().attr('href') || '',
      modelName: row.find('td.listing-modelname .listing-text-new').first().text().trim(),
      title: row.find('.listing-title-lines').first().text().trim(),
      cells: row.find('td').map((_, td) => $(td).text()).get(),
      priceText: row.find('.listing-price').first().text(),
      locs: row.find('span[title]').map((_, sp) => $(sp).attr('title')).get(),
      image: img.attr('data-src') || img.attr('src'),
    };
  }).get();
  return fromRows(rows);
}

/** Detay sayfasından hasar/boya/tramer ve teknik bilgiler. */
export async function fetchDetail(listing) {
  // Detay sayfaları düz HTTP istemcilerine kapalı; yerelde gerçek Chrome ile açılır.
  const h = interactive() ? await getHtml(listing.url) : (await fetchText(listing.url, { retries: 0 })).text;
  return parseDetail(h, listing);
}

/** Detay sayfası HTML'inden hasar/boya/tramer ve teknik bilgiler */
export function parseDetail(h, listing = {}) {
  const props = {};
  for (const m of h.matchAll(/\{"Id":\d+,"Key":"([^"]+)","Value":"([^"]*)"/g)) props[m[1]] = m[2];
  // DamageInfo.Status: 2 = "Tramer tutarı yok"; 4 = belirtilmemiş (tutar yine 0 gelir!); tutar > 0 = tramer kaydı var
  const dmg = h.match(/"DamageInfo":\{"Status":(\d+),"DamagePrice":([\d.]+)/);
  const dmgStatus = dmg ? Number(dmg[1]) : null;
  const dmgPrice = dmg ? Math.round(Number(dmg[2])) : null;
  const boya = props['Boya-değişen'] || null;
  return {
    km: parseNumber(props['Kilometre']) ?? listing.km ?? null,
    year: Number(props['Yıl']) || listing.year || null,
    color: props['Renk'] || listing.color || null,
    sellerType: props['Kimden'] === 'Sahibinden' ? 'sahibinden' : listing.sellerType,
    damage: {
      tramer: dmgPrice > 0 ? dmgPrice : dmgStatus === 2 ? 0 : null,
      tramerStatus: dmgStatus,
      heavy: props['Ağır Hasarlı'] ? props['Ağır Hasarlı'] === 'Evet' : null,
      summary: boya,
      original: boya ? /tamamı orjinal/i.test(boya) : null,
    },
    specs: {
      drive: props['Çekiş'] || null,
      hp: parseNumber(props['Motor gücü']),
      batteryKwh: parseNumber(props['Pil kapasitesi (kwh)']),
      rangeKm: parseNumber(props['Menzil']),
      series: props['Seri'] || null,
      trim: props['Model'] || null,
    },
  };
}

// Başlıktan km tahmini ("49bin km", "32.000 km", "32 bin km")
export function kmFromTitle(title) {
  const t = (title || '').toLocaleLowerCase('tr-TR');
  let m = t.match(/(\d{1,3}(?:[.,]\d{3})+)\s*km/);
  if (m) return Number(m[1].replace(/[.,]/g, ''));
  m = t.match(/(\d{1,3}(?:[.,]\d)?)\s*bin\s*(?:km|kilometre)/);
  if (m) return Math.round(Number(m[1].replace(',', '.')) * 1000);
  return null;
}

// arabam bazı yollarda (/ikinci-el/otomobil, /ilan/...) tarayıcı olmayan istemcileri engelliyor.
// Yerelde gerçek Chrome ile km sütunlu "otomobil" görünümü, bulutta izin verilen genel arama kullanılır.
async function getHtml(url) {
  if (interactive()) {
    const page = await openPage(url);
    return page.content();
  }
  return (await fetchText(url)).text;
}

/**
 * quick: en yeni ilanlar (tarih sıralı ilk sayfalar) – yeni ilanı hızla yakalamak için
 * full : tüm Tesla ilanları (alaka sıralı, Tesla sonuçları bitene kadar)
 */
export async function scan({ mode = 'quick', knownIds = null } = {}) {
  const local = interactive();
  const listPath = local ? '/ikinci-el/otomobil' : '/ikinci-el';
  const seen = new Map();
  const add = (ls) => ls.forEach((l) => {
    if (l.km == null) l.km = kmFromTitle(l.title);
    seen.set(l.sourceId, l);
  });

  if (mode === 'quick') {
    for (let page = 1; page <= (local ? 1 : 2); page++) {
      const html = await getHtml(`${BASE}${listPath}?searchText=tesla&take=50&sort=startedAt.desc${page > 1 ? `&page=${page}` : ''}`);
      add(parseList(html).listings);
      await sleep(2000);
    }
    return { listings: [...seen.values()], complete: false };
  }

  let emptyStreak = 0;
  for (let page = 1; page <= 30; page++) {
    const html = await getHtml(`${BASE}${listPath}?searchText=tesla&take=50${page > 1 ? `&page=${page}` : ''}`);
    const { listings, rowCount } = parseList(html);
    add(listings);
    if (rowCount === 0) break;
    emptyStreak = listings.length === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2 || rowCount < 50) break; // Tesla sonuçları bitti
    await sleep(local ? 2500 + Math.random() * 1500 : 1500);
  }
  log(`arabam: ${seen.size} Tesla ilanı`);
  return { listings: [...seen.values()], complete: seen.size > 20 };
}
