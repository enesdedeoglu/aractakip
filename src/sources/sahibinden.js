// sahibinden.com – otomasyonla açılan tarayıcıları tespit edip doğrulamayı döngüye sokuyor.
// Bu yüzden veriler kullanıcının KENDİ Chrome'undaki eklentiden (extension/) gelir: eklenti açık
// sahibinden sekmesindeki ilan tablosunu okur ve yerel ajana (127.0.0.1:5174) gönderir.
// Bu modül eklentiden gelen ham satırları ortak ilan biçimine çevirir.
import { parseNumber, parseTrDate } from '../util.js';

const BASE = 'https://www.sahibinden.com';

// Araç fotoğrafı: /photos/ (büyük boyuta çevrilir) veya öne çıkan ilan önizlemesi; simgeler atlanır
export function pickImage(r) {
  const cands = [...(r.images || []), r.image].filter((u) => typeof u === 'string' && /^https?:/.test(u));
  const photo = cands.find((u) => /\/photos\//.test(u) && /\.(jpe?g|webp|avif)/i.test(u));
  if (photo) return photo.replace(/\/(lthmb|thmb)_/, '/x5_').replace(/\.avif$/, '.jpg');
  return cands.find((u) => /primeRow|pr_thmb_/.test(u)) || null;
}

function toListing(r, heads) {
  const lc = (s) => (s || '').toLocaleLowerCase('tr-TR');
  const hs = heads.map(lc);
  // Sütun başlıkları: "", Seri, Model, İlan Başlığı, Yıl, KM, Renk, Fiyat, İlan Tarihi, İl / İlçe
  const byHead = (...names) => {
    let i = hs.findIndex((h) => names.includes(h));
    if (i < 0) i = hs.findIndex((h) => names.some((n) => h.startsWith(n)));
    return i >= 0 && r.cells[i] ? r.cells[i].text : null;
  };
  const byCls = (cls) => r.cells.filter((c) => (c.cls || '').includes(cls)).map((c) => c.text);
  const tags = byCls('searchResultsTagAttributeValue');
  const attrs = byCls('searchResultsAttributeValue');
  const seri = byHead('seri') ?? tags[0] ?? '';
  const model = byHead('model') ?? tags[1] ?? '';
  const yearTxt = byHead('yıl') ?? attrs.find((t) => /^(19|20)\d{2}$/.test(t));
  const kmTxt = byHead('km') ?? attrs.find((t) => /^\d{1,3}(\.\d{3})+$|^\d{1,6}$/.test(t) && !/^(19|20)\d{2}$/.test(t));
  const priceTxt = byHead('fiyat') ?? byCls('searchResultsPriceValue')[0];
  const dateTxt = byHead('ilan tarihi') ?? byCls('searchResultsDateValue')[0];
  const locTxt = byHead('il / ilçe', 'il/ilçe') ?? byCls('searchResultsLocationValue')[0] ?? '';
  const [city, ...rest] = locTxt.split(/\s+/).filter(Boolean);
  const href = r.href || '';
  const price = parseNumber(priceTxt);
  return {
    source: 'sahibinden',
    sourceId: String(r.id),
    url: href ? (href.startsWith('http') ? href : BASE + href) : `${BASE}/ilan/${r.id}/detay`,
    title: r.title || '',
    modelRaw: `Tesla ${seri} ${model}`.replace(/\s+/g, ' ').trim(),
    year: yearTxt && /^\d{4}$/.test(yearTxt.trim()) ? Number(yearTxt) : null,
    km: parseNumber(kmTxt),
    price: price && price > 50000 ? price : null,
    currency: r.currency && r.currency !== 'TL' ? 'FX' : /€|eur|\$|usd/i.test(priceTxt || '') ? 'FX' : 'TRY',
    city: city || null,
    district: rest.join(' ') || null,
    sellerType: r.store ? 'galeri' : 'sahibinden',
    image: pickImage(r),
    color: byHead('renk'),
    publishedAt: parseTrDate((dateTxt || '').replace(/(\d{1,2})\s+(\S+)\s+(\d{4}).*/s, '$1 $2 $3')),
    damage: { tramer: null, heavy: null, summary: null, original: null },
  };
}

/**
 * @param pages [{ url, heads: string[], rows: [{id, href, title, image, store, cells:[{cls,text}]}] }]
 */
export function normalize(pages) {
  const out = new Map();
  for (const p of pages) {
    for (const r of p.rows || []) {
      if (!r.id) continue;
      const l = toListing(r, p.heads || []);
      // Yalnızca Tesla (marka sayfası dışında arama yapılırsa diye)
      if (!/tesla/i.test(`${l.modelRaw} ${l.title} ${p.url}`)) continue;
      if (l.currency !== 'TRY') l.price = null; // döviz fiyatlı ilanlar fiyat modeline girmesin
      out.set(l.sourceId, l);
    }
  }
  return [...out.values()];
}

export async function scan() {
  throw new Error('sahibinden doğrudan taranmaz; Chrome eklentisi (extension/) verileri yerel ajana gönderir');
}
