// Chrome eklentisi köprüsü.
// Eklenti, kullanıcının kendi Chrome'unda tek bir sabitlenmiş sekme kullanır: ajandan sıradaki adresi
// ister (GET /next), sekmede açar, sayfa içeriğini geri gönderir (POST /page). Hangi sayfanın ne zaman
// açılacağına ve sayfaların nasıl işleneceğine burada karar verilir.
import { parseList as parseArabamList, parseDetail as parseArabamDetail, kmFromTitle } from './sources/arabam.js';
import { parseNextData as parseBorusan, toListing as borusanListing } from './sources/borusan.js';
import { normalize as normalizeSahibinden } from './sources/sahibinden.js';
import { log } from './util.js';

const MIN = 60000;
const SAH = 'https://www.sahibinden.com/tesla?pagingSize=50&sorting=date_desc';
const ARB = 'https://www.arabam.com/ikinci-el/otomobil?searchText=tesla&take=50';
const BOR = 'https://borusannext.com/araba-al/tesla';

/**
 * @param opts.onScan (scan) => Promise   – tamamlanan taramayı veritabanına işler
 * @param opts.needDetail () => string[]  – detay bilgisi eksik arabam ilan adresleri
 * @param opts.onChallenge (url) => void
 */
export function createBridge({ onScan, needDetail, onChallenge, intervals = {} }) {
  const iv = {
    sahibinden: 5, sahibindenFull: 360,
    arabam: 3, arabamFull: 60,
    borusan: 5,
    gap: 0.4, // iki sayfa açılışı arasındaki en kısa süre (dk)
    ...intervals,
  };
  const last = {};          // görev adı -> son çalışma zamanı
  let crawl = null;         // süren çok sayfalı tarama { source, pages, nextUrl, started }
  let inflight = null;      // { url, task, at }
  let lastNav = 0;
  let lastSeen = 0;         // eklentinin son bağlantısı
  let detailQueue = [];
  const failedDetail = new Set();
  const requested = new Map();

  const due = (task, every) => Date.now() - (last[task] || 0) >= every * MIN;

  function next() {
    lastSeen = Date.now();
    if (inflight && Date.now() - inflight.at < 75000) return null; // önceki sayfa bekleniyor
    if (inflight) {
      log(`eklenti: ${inflight.task} zaman aşımı`);
      if (crawl && inflight.task === 'crawl') { last[crawl.source] = Date.now(); crawl = null; }
      else last[inflight.task] = Date.now();
      inflight = null;
    }
    if (Date.now() - lastNav < iv.gap * MIN) return null;

    let pick = null;
    if (crawl && crawl.nextUrl) pick = { task: 'crawl', url: crawl.nextUrl };
    else if (due('arabam', iv.arabam)) pick = due('arabamFull', iv.arabamFull)
      ? (crawl = { source: 'arabam', pages: [], page: 1, emptyStreak: 0, nextUrl: ARB, started: Date.now() }, { task: 'crawl', url: ARB })
      : { task: 'arabam', url: `${ARB}&sort=startedAt.desc` };
    else if (due('sahibinden', iv.sahibinden)) pick = due('sahibindenFull', iv.sahibindenFull)
      ? (crawl = { source: 'sahibinden', pages: [], offset: 0, nextUrl: SAH, started: Date.now() }, { task: 'crawl', url: SAH })
      : { task: 'sahibinden', url: SAH };
    else if (due('borusan', iv.borusan)) pick = { task: 'borusan', url: BOR };
    else {
      // Aynı detay sayfası bir saat içinde tekrar istenmesin (kayıt henüz yazılmamış olabilir)
      const fresh = (u) => !failedDetail.has(u) && Date.now() - (requested.get(u) || 0) > 60 * MIN;
      if (!detailQueue.length) detailQueue = needDetail().filter(fresh).slice(0, 10);
      const u = detailQueue.shift();
      if (u) { requested.set(u, Date.now()); pick = { task: 'arabamDetail', url: u }; }
    }
    if (!pick) return null;
    if (pick.task === 'crawl') crawl.nextUrl = null;
    inflight = { ...pick, at: Date.now() };
    lastNav = Date.now();
    return pick.url;
  }

  async function page({ url, kind, html, nextData, heads, rows, total, challenge }) {
    lastSeen = Date.now();
    const task = inflight?.task;
    const done = () => { if (task && task !== 'crawl') last[task] = Date.now(); inflight = null; };
    if (challenge) {
      onChallenge?.(url);
      // Doğrulama ekranında beklemeyelim: görevi ertele (kullanıcı geçince sonraki turda tekrar denenir)
      if (task === 'crawl' && crawl) { last[crawl.source] = last[`${crawl.source}Full`] = Date.now(); crawl = null; }
      else if (task) last[task] = Date.now();
      inflight = null;
      return;
    }
    const host = new URL(url).host;
    try {
      if (host.endsWith('sahibinden.com') && rows) {
        const pg = { url, heads, rows };
        if (task === 'crawl' && crawl?.source === 'sahibinden') {
          crawl.pages.push(pg);
          const more = rows.length >= 50 && crawl.offset + 50 < Math.min(total || 1000, 1000);
          inflight = null;
          if (more) { crawl.offset += 50; crawl.nextUrl = `${SAH}&pagingOffset=${crawl.offset}`; return; }
          const listings = normalizeSahibinden(crawl.pages);
          const complete = !total || listings.length >= total * 0.9;
          crawl = null;
          last.sahibinden = last.sahibindenFull = Date.now();
          return onScan({ source: 'sahibinden', listings, complete, mode: 'full' });
        }
        done();
        if (rows.length && !normalizeSahibinden([pg]).length) log('sahibinden: satırlar ayrıştırılamadı, başlıklar:', heads);
        return onScan({ source: 'sahibinden', listings: normalizeSahibinden([pg]), complete: false, mode: 'quick' });
      }
      if (host.endsWith('arabam.com') && html) {
        if (/\/ilan\//.test(new URL(url).pathname)) {
          done();
          const id = (url.match(/\/(\d+)(?:[?#].*)?$/) || [])[1];
          if (!id || !/DamageInfo|"Key":"Marka"/.test(html)) { failedDetail.add(url); return; }
          const detail = parseArabamDetail(html);
          return onScan({ source: 'arabam', listings: [{ source: 'arabam', sourceId: id, ...detail, detailAt: new Date().toISOString() }], complete: false, mode: 'detail' });
        }
        const { listings, rowCount } = parseArabamList(html);
        listings.forEach((l) => { if (l.km == null) l.km = kmFromTitle(l.title); });
        if (task === 'crawl' && crawl?.source === 'arabam') {
          crawl.pages.push(...listings);
          crawl.emptyStreak = listings.length ? 0 : crawl.emptyStreak + 1;
          inflight = null;
          if (rowCount >= 50 && crawl.emptyStreak < 2 && crawl.page < 30) {
            crawl.page += 1; crawl.nextUrl = `${ARB}&page=${crawl.page}`; return;
          }
          const all = [...new Map(crawl.pages.map((l) => [l.sourceId, l])).values()];
          crawl = null;
          last.arabam = last.arabamFull = Date.now();
          return onScan({ source: 'arabam', listings: all, complete: all.length > 20, mode: 'full' });
        }
        done();
        return onScan({ source: 'arabam', listings, complete: false, mode: 'quick' });
      }
      if (host.endsWith('borusannext.com') && (nextData || html)) {
        done();
        const { datas } = parseBorusan(nextData || html);
        const listings = datas.filter((d) => /tesla/i.test(d.brand) && !d.isSold).map(borusanListing);
        // Tesla sayısı 12'yi geçerse (Borusan sayfa başına 12 gösteriyor) diğer sayfalar da eklenebilir
        return onScan({ source: 'borusan', listings, complete: true, mode: 'full' });
      }
      done();
    } catch (e) {
      log(`eklenti sayfası işlenemedi (${host}): ${e.message}`);
      if (task === 'crawl' && crawl) { last[crawl.source] = Date.now(); crawl = null; }
      done();
    }
  }

  const status = () => ({
    connected: Date.now() - lastSeen < 2 * MIN,
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    crawl: crawl ? { source: crawl.source, pages: crawl.pages.length } : null,
    inflight: inflight?.task || null,
    last: Object.fromEntries(Object.entries(last).map(([k, v]) => [k, new Date(v).toISOString()])),
  });

  return { next, page, status };
}
