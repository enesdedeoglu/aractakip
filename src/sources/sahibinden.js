// sahibinden.com – otomasyonla açılan tarayıcıları tespit edip doğrulamayı döngüye sokuyor.
// Bu yüzden veriler kullanıcının KENDİ Chrome'undaki eklentiden (extension/) gelir: eklenti açık
// sahibinden sekmesindeki ilan tablosunu okur ve yerel ajana (127.0.0.1:5174) gönderir.
// Bu modül eklentiden gelen ham satırları ortak ilan biçimine çevirir.
import { parseNumber, parseTrDate } from '../util.js';
import { fold } from '../classify.js';
import { parseDescription } from '../describe.js';

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
    // Listede küçük fotoğrafı olmayan ilan (fotoğraflar yalnızca ilan sayfasında)
    megaPhoto: !pickImage(r) && /iconHasMegaPhoto|otherNoImage|Megafotolu/i.test(`${r.image || ''} ${(r.images || []).join(' ')} ${r.imgHtml || ''}`) ? true : undefined,
    color: byHead('renk'),
    publishedAt: parseTrDate((dateTxt || '').replace(/(\d{1,2})\s+(\S+)\s+(\d{4}).*/s, '$1 $2 $3')),
    damage: { tramer: null, heavy: null, summary: null, original: null },
  };
}

/**
 * @param pages [{ url, heads: string[], rows: [{id, href, title, image, store, cells:[{cls,text}]}] }]
 */
// sahibinden şüpheli ziyaretçilere sahte (tuzak) ilanlar karıştırıyor: 9 haneli numara, adreste "sb2f" işareti,
// rastgele kalıp başlıklar ve fotoğraf yok. Gerçek ilan numaraları 10 hanelidir.
export function isFakeRow(r) {
  return !/^\d{10,}$/.test(String(r.id || '')) || /-sb2f-/i.test(r.href || '');
}

export function normalize(pages) {
  const out = new Map();
  for (const p of pages) {
    for (const r of p.rows || []) {
      if (!r.id || isFakeRow(r)) continue;
      const l = toListing(r, p.heads || []);
      // Yalnızca Tesla (marka sayfası dışında arama yapılırsa diye)
      if (!/tesla/i.test(`${l.modelRaw} ${l.title} ${p.url}`)) continue;
      if (l.currency !== 'TRY') l.price = null; // döviz fiyatlı ilanlar fiyat modeline girmesin
      out.set(l.sourceId, l);
    }
  }
  return [...out.values()];
}

// ---------- İlan detay sayfası ----------
const DAY = 86400000;
const GROUPS = [
  ['changed', /^de[gğ]i[sş](mi[sş]|en)/],
  ['local', /^lokal/],
  ['painted', /^boyal/],
  ['original', /^or[ij]+inal|^orjinal/],
  ['unknown', /^belirtilmemi/],
];

/**
 * Eklentinin detay sayfasından okuduğu bilgiyi ilan alanlarına çevirir.
 * @param d { id, props: { "Ağır Hasar Kayıtlı": "Hayır", ... }, desc, damage: [{ label, items, text }], parts: [{ cls, text }] }
 */
export function parseDetail(d = {}) {
  const props = Object.fromEntries(Object.entries(d.props || {}).map(([k, v]) => [fold(k).replace(/[^a-z0-9 ]/g, '').trim(), String(v ?? '').trim()]));
  const get = (...keys) => keys.map((k) => props[k]).find((v) => v);
  const heavyTxt = fold(get('agir hasar kayitli', 'agir hasarli', 'agir hasar') || '');
  const heavy = /^evet/.test(heavyTxt) ? true : /^hayir/.test(heavyTxt) ? false : null;

  // Boya / değişen grupları: parça sayısı
  const n = { changed: 0, local: 0, painted: 0, original: 0, unknown: 0 };
  let groups = 0;
  for (const g of d.damage || []) {
    const label = fold(g.label).replace(/\s*parcalar\s*:?$/, '').replace(/:$/, '').trim();
    const kind = GROUPS.find(([, re]) => re.test(label))?.[0];
    if (!kind) continue;
    groups++;
    const items = (g.items || []).filter((t) => !/^(yok|-|belirtilmemis)$/i.test(fold(t)));
    n[kind] += items.length;
  }
  // Yedek: parça şemasındaki sınıf adları (grup başlığı bulunamadıysa)
  if (!groups && (d.parts || []).length) {
    for (const p of d.parts) {
      const c = fold(p.cls);
      if (/chang|degis/.test(c)) n.changed++;
      else if (/local|lokal/.test(c)) n.local++;
      else if (/paint|boya/.test(c)) n.painted++;
      else if (/orig|orij/.test(c)) n.original++;
    }
    groups = n.changed + n.local + n.painted + n.original ? 1 : 0;
  }
  const bad = n.changed + n.painted + n.local;
  let summary = [n.changed && `${n.changed} değişen`, n.painted && `${n.painted} boyalı`, n.local && `${n.local} lokal boyalı`].filter(Boolean).join(', ') || null;
  if (!summary && groups && n.original) summary = 'Tamamı orjinal';
  // Bazı ilanlarda özellik listesinde doğrudan "Boya-değişen" alanı var
  const paintProp = Object.entries(props).find(([k]) => /boya|degis/.test(k))?.[1];
  if (!summary && paintProp && !/belirtilmemis/.test(fold(paintProp))) summary = paintProp.slice(0, 80);

  // Tramer: özellik listesinde varsa oradan, yoksa açıklamadan
  const tramerProp = Object.entries(props).find(([k]) => /tramer/.test(k))?.[1];
  const tramer = tramerProp ? parseDescription(`tramer ${tramerProp}`).tramer : parseDescription(d.desc).tramer;

  const kimden = fold(get('kimden') || '');
  const num = (v) => { const x = parseNumber(v); return x && x > 0 ? x : null; };
  const specs = Object.fromEntries(Object.entries({
    drive: get('cekis') || null,
    hp: num(get('motor gucu')),
    batteryKwh: num(get('batarya kapasitesi', 'pil kapasitesi', 'batarya kapasitesi kwh')),
    rangeKm: num(get('menzil', 'maksimum menzil')),
    series: get('seri') || null,
    trim: get('model') || null,
  }).filter(([, v]) => v != null));
  const damage = Object.fromEntries(Object.entries({
    heavy,
    heavyBy: heavy != null ? 'detay' : null,
    summary,
    original: summary ? !bad && n.original > 0 : null,
    painted: groups ? n.painted + n.local > 0 : null,
    changed: groups ? n.changed > 0 : null,
    tramer,
    tramerFrom: tramer != null ? (tramerProp ? 'ilan' : 'açıklama') : null,
  }).filter(([, v]) => v != null));
  const out = { damage, specs };
  const desc = (d.desc || '').replace(/\s+/g, ' ').trim();
  if (desc) out.description = desc.slice(0, 1500);
  if (kimden) out.sellerType = /sahibinden/.test(kimden) ? 'sahibinden' : 'galeri';
  if (/^evet/.test(fold(get('garanti') || ''))) out.warranty = 'Garantili';
  const color = get('renk');
  if (color) out.color = color;
  return out;
}

/**
 * Detay sayfası okunacak sahibinden ilanları, öncelik sırasıyla: son 2 günde görülen yeni ilanlar (en yenisi
 * önce), sonra değerlendirmesi detaya bağlı olanlar (Fırsat / Şüpheli, versiyonu fiyatla tahmin edilen ucuzlar).
 */
export function detailCandidates(listings, now = Date.now()) {
  const ok = (l) => l.source === 'sahibinden' && l.status === 'active' && !l.detailAt && /\/ilan\//.test(l.url || '');
  const fresh = listings.filter((l) => ok(l) && now - Date.parse(l.firstSeen) < 2 * DAY)
    .sort((a, b) => Date.parse(b.firstSeen) - Date.parse(a.firstSeen));
  const seen = new Set(fresh);
  const valuable = listings.filter((l) => ok(l) && !seen.has(l) && (['Fırsat', 'Şüpheli'].includes(l.a?.label) || (l.c?.trimAlt && l.a?.label === 'İyi fiyat')))
    .sort((a, b) => (a.a?.z ?? 0) - (b.a?.z ?? 0));
  return [...fresh, ...valuable].map((l) => l.url);
}

/** Kayıt için kısa özet: "ağır hasar: Hayır · 2 boyalı · tramer 85 bin (açıklama) · açıklama 640 kr" */
export function detailSummary(x) {
  const d = x.damage || {};
  return [
    `ağır hasar: ${d.heavy === true ? 'Evet' : d.heavy === false ? 'Hayır' : '?'}`,
    d.summary || 'boya/değişen ?',
    d.tramer != null ? `tramer ${d.tramer ? `${Math.round(d.tramer / 1000)} bin` : 'yok'} (${d.tramerFrom})` : null,
    x.specs?.drive ? `çekiş ${x.specs.drive}` : null,
    `açıklama ${x.description?.length || 0} kr`,
  ].filter(Boolean).join(' · ');
}

export async function scan() {
  throw new Error('sahibinden doğrudan taranmaz; Chrome eklentisi (extension/) verileri yerel ajana gönderir');
}
