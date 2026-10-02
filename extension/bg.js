// Arka plan: ajandan (127.0.0.1:5174) sıradaki adresi ister, kendi sabitlenmiş sekmesinde açar ve
// içerik betiğinin okuduğu sayfayı ajana iletir. Hangi sitenin ne zaman açılacağına ajan karar verir.
const AGENT = 'http://127.0.0.1:5174';

const get = async () => ({ enabled: true, ...(await chrome.storage.local.get(null)) });
const set = (o) => chrome.storage.local.set(o);

async function badge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

async function ourTab() {
  const { tabId } = await get();
  if (!tabId) return null;
  return chrome.tabs.get(tabId).catch(() => null);
}

async function open(url) {
  let tab = await ourTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url, pinned: true, active: false });
    await set({ tabId: tab.id });
  } else {
    await chrome.tabs.update(tab.id, { url });
  }
}

async function tick() {
  const st = await get();
  if (!st.enabled) { await badge('off', '#888'); return; }
  try {
    const res = await fetch(`${AGENT}/next`);
    const { url } = await res.json();
    await set({ agentOk: true, lastError: null });
    if (url) { await open(url); await set({ lastUrl: url, lastNav: Date.now() }); }
    if ((await chrome.action.getBadgeText({})) === '×') await badge('', '#11804a');
  } catch {
    await set({ agentOk: false, lastError: 'Bilgisayardaki ajan çalışmıyor' });
    await badge('×', '#666');
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
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

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick(); });
// Servis çalışanı her uyandığında alarmı sıfırlamamak için yalnızca yoksa oluştur
async function schedule() {
  if (!(await chrome.alarms.get('tick'))) chrome.alarms.create('tick', { periodInMinutes: 0.5, delayInMinutes: 0.05 });
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
schedule();
