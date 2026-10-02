// Otokoç 2. El – Next.js sayfasındaki gömülü veriden okunur, düz HTTP ile çalışır.
import { fetchText, sleep } from '../util.js';

const BASE = 'https://www.otokocikinciel.com';
const IMG = 'https://2el-cdn.otokoc.com.tr/otokoc2el/car/450x/';

function extractResults(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,(".*?")\]\)<\/script>/gs)];
  const flight = chunks.map((m) => { try { return JSON.parse(m[1]); } catch { return ''; } }).join('');
  const results = [];
  let paging = null;
  let idx = 0;
  // Sayfada birden çok "results" dizisi olabilir (liste + öneriler); hepsini topla, sonra markaya göre süz.
  while ((idx = flight.indexOf('"results":[', idx)) !== -1) {
    const start = idx + '"results":'.length;
    try {
      const { value } = rawDecode(flight, start);
      if (Array.isArray(value)) results.push(...value.filter((r) => r && r.specifications && typeof r.specifications === 'object'));
    } catch { /* yoksay */ }
    idx = start;
  }
  const pm = flight.match(/"paging":\{"total":(\d+),"page":(\d+),"itemPerPage":(\d+),"totalPage":(\d+)/);
  if (pm) paging = { total: +pm[1], page: +pm[2], perPage: +pm[3], totalPage: +pm[4] };
  return { results, paging };
}

// JSON.parse ile belirli bir konumdan başlayan tek JSON değerini oku
function rawDecode(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return { value: JSON.parse(s.slice(start, i + 1)), end: i + 1 };
    }
  }
  throw new Error('JSON sonu bulunamadı');
}

function toListing(r) {
  const sp = r.specifications;
  const retail = (r.prices || []).find((p) => p.pricingTypeName === 'RetailPrice') || (r.prices || [])[0];
  const reserved = (r.badges || []).some((b) => b.name === 'Optioned');
  return {
    source: 'otokoc',
    sourceId: String(r.id),
    url: `${BASE}/ilan/${r.slug}`,
    title: r.advertName,
    modelRaw: `Tesla ${titleCase(sp.model || '')} ${sp.equipmentLevelName || ''}`.trim(),
    year: sp.modelYear || null,
    km: sp.mileages ?? null,
    price: retail ? retail.price : null,
    city: r.cityName || null,
    sellerType: 'kurumsal',
    sellerName: r.advertiserTypeName || 'Otokoç 2. El',
    image: r.productImageUrls && r.productImageUrls[0] ? IMG + r.productImageUrls[0] : null,
    color: sp.color || null,
    publishedAt: r.confirmationDate || null,
    reserved,
    warranty: sp.warranty || null,
    damage: { tramer: null, heavy: null, summary: null, original: null },
  };
}

const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export async function scan() {
  const all = new Map();
  for (let page = 1; page <= 20; page++) {
    const { text } = await fetchText(`${BASE}/ikinci-el/tesla${page > 1 ? `?page=${page}` : ''}`);
    const { results, paging } = extractResults(text);
    const teslas = results.filter((r) => String(r.specifications.make).toUpperCase() === 'TESLA');
    teslas.forEach((r) => all.set(String(r.id), toListing(r)));
    if (!teslas.length || !paging || page >= paging.totalPage) break;
    await sleep(1000);
  }
  return { listings: [...all.values()], complete: true };
}
