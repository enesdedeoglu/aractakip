// Arka plan: belirli aralıklarla sahibinden Tesla sayfasını (kendi sabitlenmiş sekmesinde) yeniler,
// içerik betiğinden gelen ilanları yerel ajana gönderir. Birkaç saatte bir tüm sayfaları gezer (tam tarama).
const AGENT = 'http://127.0.0.1:5174';
const BASE = 'https://www.sahibinden.com/tesla?pagingSize=50&sorting=date_desc';
const DEFAULTS = { enabled: true, intervalMin: 5, fullEveryMin: 360 };

const get = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });
const set = (o) => chrome.storage.local.set(o);

async function badge(text, color = '#e82127') {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

async function post(body) {
  try {
    const res = await fetch(`${AGENT}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = res.ok;
    await set({ lastPost: Date.now(), agentOk: ok, lastError: ok ? null : `ajan ${res.status}` });
    return ok;
  } catch (e) {
    await set({ agentOk: false, lastError: 'Ajan çalışmıyor (npm run agent)' });
    await badge('×', '#666');
    return false;
  }
}

async function ensureTab(url) {
  const st = await get();
  let tab = st.tabId ? await chrome.tabs.get(st.tabId).catch(() => null) : null;
  if (tab && tab.url && !tab.url.startsWith('https://www.sahibinden.com/')) tab = null; // kullanıcı başka yere gitmiş
  if (!tab) {
    tab = await chrome.tabs.create({ url, pinned: true, active: false });
    await set({ tabId: tab.id });
  } else {
    await chrome.tabs.update(tab.id, { url });
  }
}

async function tick(force = false) {
  const st = await get();
  if (!st.enabled && !force) return;
  const now = Date.now();
  // Tam tarama zamanı geldiyse sayfa sayfa gez
  if (!st.crawl && now - (st.lastFull || 0) > st.fullEveryMin * 60000) {
    await set({ crawl: { offset: 0, pages: [], startedAt: now } });
    return ensureTab(BASE);
  }
  if (st.crawl && now - st.crawl.startedAt > 30 * 60000) await set({ crawl: null }); // takılan taramayı bırak
  else if (st.crawl) return; // tam tarama sürüyor; sonraki adımı sayfa mesajı tetikler
  await ensureTab(BASE);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    const st = await get();
    if (msg.type === 'challenge') {
      await badge('!');
      await post({ type: 'challenge', url: msg.url });
      return;
    }
    if (msg.type !== 'page') return;
    await set({ lastPage: Date.now(), lastCount: msg.rows.length, total: msg.total });
    if (st.crawl && sender.tab?.id === st.tabId) {
      const crawl = st.crawl;
      crawl.pages.push({ url: msg.url, heads: msg.heads, rows: msg.rows });
      const more = msg.rows.length >= 50 && crawl.offset + 50 < Math.min(msg.total || 1000, 1000);
      if (more) {
        crawl.offset += 50;
        await set({ crawl });
        // Siteye yük bindirmemek için sayfalar arasında ~30 sn bekle
        chrome.alarms.create('crawlNext', { when: Date.now() + 30000 });
      } else {
        const ok = await post({ type: 'scan', complete: true, total: msg.total, pages: crawl.pages });
        await set({ crawl: null, lastFull: ok ? Date.now() : st.lastFull });
      }
    } else {
      await post({ type: 'scan', complete: false, total: msg.total, pages: [{ url: msg.url, heads: msg.heads, rows: msg.rows }] });
    }
    await badge(String(msg.rows.length), '#11804a');
  })();
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'tick') return tick();
  if (a.name === 'crawlNext') {
    const st = await get();
    if (st.crawl) ensureTab(`${BASE}&pagingOffset=${st.crawl.offset}`);
  }
});

async function schedule() {
  const st = await get();
  await chrome.alarms.clear('tick');
  chrome.alarms.create('tick', { periodInMinutes: Math.max(1, st.intervalMin), delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.storage.onChanged.addListener((c) => { if (c.intervalMin) schedule(); });

// Açılır pencereden gelen komutlar
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'scanNow') tick(true);
  if (msg.type === 'fullNow') set({ lastFull: 0, crawl: null }).then(() => tick(true));
});
