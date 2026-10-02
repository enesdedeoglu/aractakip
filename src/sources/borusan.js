// Borusan Next – Cloudflare korumalı. Önce düz HTTP denenir, engellenirse gerçek Chrome kullanılır.
import { fetchText, BlockedError, sleep } from '../util.js';
import { openPage } from '../browser.js';

const BASE = 'https://borusannext.com';

export function parseNextData(html) {
  // Tam HTML veya doğrudan __NEXT_DATA__ JSON metni kabul edilir
  const m = html.trimStart().startsWith('{') ? [null, html] : html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) throw new Error('Borusan: __NEXT_DATA__ bulunamadı');
  const p = JSON.parse(m[1]).props.pageProps;
  return { count: p.count || 0, datas: p.datas || [] };
}

export function toListing(d) {
  return {
    source: 'borusan',
    sourceId: String(d.announcementNo || d.id),
    url: `${BASE}/araba-al/${d.brandSlug}/${d.modelSlug}/${d.announcementNo}`,
    title: `${d.brand} ${d.model} ${d.modelName || ''}`.trim(),
    modelRaw: `Tesla ${d.model} ${d.modelExtension || d.modelName || ''}`.trim(),
    year: d.year || null,
    km: d.km ?? null,
    price: d.currentListingPrice || d.salePrice || null,
    city: d.branchInfo?.cityName || d.addressInfo?.city || null,
    district: d.branchInfo?.name || null,
    sellerType: 'kurumsal',
    sellerName: d.sellerCustomerName || 'Borusan Next',
    image: (d.listingPhotos || d.allPhotos || [])[0] || null,
    color: d.paint || null,
    publishedAt: d.publishDate ? new Date(d.publishDate + (/[zZ+]/.test(d.publishDate.slice(-6)) ? '' : '+03:00')).toISOString() : null,
    reserved: !!(d.isReserved || d.isOptionedAtSap),
    sold: !!d.isSold,
    warranty: d.warranty || null,
    certified: !!d.isCertified,
    views: d.viewsCount ?? null,
    damage: {
      tramer: d.hasTramerRecord === false ? 0 : null,
      tramerRecord: d.hasTramerRecord ?? null,
      heavy: null,
      painted: d.painted ?? null,
      changed: d.partChanged ?? null,
      original: d.painted === false && d.partChanged === false,
      summary: d.painted === false && d.partChanged === false ? 'Boyasız, değişensiz' :
        [d.painted && 'Boyalı parça var', d.partChanged && 'Değişen parça var'].filter(Boolean).join(', ') || null,
    },
    specs: { batterySoh: d.batterySoh || null, trim: d.modelName || null, series: d.model || null },
  };
}

async function getHtml(url) {
  try {
    return (await fetchText(url, { retries: 0 })).text;
  } catch (e) {
    if (!(e instanceof BlockedError)) throw e;
    const page = await openPage(url);
    await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 30_000 });
    return page.content();
  }
}

export async function scan() {
  const all = new Map();
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const html = await getHtml(`${BASE}/araba-al/tesla${pageNo > 1 ? `?pageNumber=${pageNo}` : ''}`);
    const { count, datas } = parseNextData(html);
    datas.filter((d) => /tesla/i.test(d.brand) && !d.isSold).forEach((d) => all.set(String(d.announcementNo || d.id), toListing(d)));
    if (all.size >= count || datas.length === 0) break;
    await sleep(2500);
  }
  return { listings: [...all.values()], complete: true };
}
