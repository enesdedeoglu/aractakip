// Arka plan: ajandan (127.0.0.1:5174) sıradaki adresi ister, kendi sabitlenmiş sekmesinde açar ve
// içerik betiğinin okuduğu sayfayı ajana iletir. Hangi sitenin ne zaman açılacağına ajan karar verir.
// Chrome (chrome.*) ve Firefox (browser.*, Promise tabanlı) için ortak API
const api = globalThis.browser ?? globalThis.chrome;
const AGENT = 'http://127.0.0.1:5174';

const get = async () => ({ enabled: true, ...(await api.storage.local.get(null)) });
const set = (o) => api.storage.local.set(o);

// MV3'te action, Firefox MV2'de browserAction; Android'de rozet desteklenmeyebilir
const action = api.action || api.browserAction;
let lastBadge = '';
async function badge(text, color) {
  lastBadge = text;
  try {
    await action.setBadgeBackgroundColor({ color });
    await action.setBadgeText({ text });
  } catch { /* rozet desteklenmiyor */ }
}

let android = null;
async function isAndroid() {
  if (android == null) android = (await api.runtime.getPlatformInfo().catch(() => ({}))).os === 'android';
  return android;
}

async function ourTab() {
  const { tabId } = await get();
  if (!tabId) return null;
  return api.tabs.get(tabId).catch(() => null);
}

// Hataları ajanın kayıtlarına gönder (eklentinin konsolu tablette görünmüyor)
function report(where, e) {
  fetch(`${AGENT}/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ where, error: String(e && (e.message || e)) }) }).catch(() => {});
}

async function open(url) {
  let tab = await ourTab();
  if (tab) { await api.tabs.update(tab.id, { url }); return; }
  if (await isAndroid()) {
    // Android'de sabitlenmiş sekme yok; tablet bu iş için ayrıldığından sekme önde açılır
    // (arka plandaki sekmeleri Android askıya alabiliyor)
    try {
      tab = await api.tabs.create({ url });
    } catch (e) {
      report('tabs.create', e);
      [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw e;
      await api.tabs.update(tab.id, { url });
    }
  } else {
    tab = await api.tabs.create({ url, pinned: true, active: false });
  }
  await set({ tabId: tab.id });
}

async function tick() {
  const st = await get();
  if (!st.enabled) { await badge('off', '#888'); return; }
  let url;
  try {
    ({ url } = await (await fetch(`${AGENT}/next`)).json());
    await set({ agentOk: true, lastError: null });
    if (lastBadge === '×') await badge('', '#11804a');
  } catch {
    await set({ agentOk: false, lastError: 'Ajan çalışmıyor (bilgisayar/tablet)' });
    await badge('×', '#666');
    return;
  }
  if (!url) return;
  try {
    await open(url);
    await set({ lastUrl: url, lastNav: Date.now() });
  } catch (e) {
    await set({ lastError: `Sekme açılamadı: ${e.message || e}` });
    report('open', e);
  }
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'tick') { tick(); return; }
  (async () => {
    const { tabId } = await get();
    if (!sender.tab || sender.tab.id !== tabId) return; // yalnızca kendi sekmemiz
    if (msg.challenge) await badge('!', '#e82127');
    else await badge('', '#11804a');
    await set({ lastPage: Date.now(), lastKind: msg.kind || (msg.challenge ? 'doğrulama' : '?') });
    await fetch(`${AGENT}/page`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }).catch(() => {});
    tick(); // sıradaki sayfa hazırsa beklemeden geç
  })();
});

api.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick(); });
// Servis çalışanı her uyandığında alarmı sıfırlamamak için yalnızca yoksa oluştur
async function schedule() {
  if (!(await api.alarms.get('tick'))) api.alarms.create('tick', { periodInMinutes: 0.5, delayInMinutes: 0.05 });
}
api.runtime.onInstalled.addListener(schedule);
api.runtime.onStartup.addListener(schedule);
schedule();
