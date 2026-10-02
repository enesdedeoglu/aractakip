// Chrome (chrome.*) ve Firefox (browser.*, Promise tabanlı) için ortak API
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const ago = (t) => (t ? `${Math.max(0, Math.round((Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 60000))} dk önce` : '—');
async function render() {
  const s = { enabled: true, ...(await api.storage.local.get(null)) };
  $('enabled').checked = s.enabled;
  $('last').textContent = s.lastPage ? `${s.lastKind} · ${ago(s.lastPage)}` : '—';
  $('err').textContent = s.lastError || '';
  try {
    const st = await (await fetch('http://127.0.0.1:5174/status')).json();
    $('agent').textContent = 'çalışıyor';
    $('crawl').textContent = st.crawl ? `${st.crawl.source} (${st.crawl.pages})` : 'yok';
    for (const k of ['arabam', 'sahibinden', 'borusan']) $(k).textContent = ago(st.last?.[k]);
  } catch {
    $('agent').textContent = 'çalışmıyor';
  }
}
$('enabled').onchange = (e) => api.storage.local.set({ enabled: e.target.checked });
$('tab').onclick = async () => {
  const { tabId } = await api.storage.local.get('tabId');
  if (tabId) api.tabs.update(tabId, { active: true }).catch(() => {});
};
render();
