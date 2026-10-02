const $ = (id) => document.getElementById(id);
const ago = (t) => (t ? `${Math.round((Date.now() - t) / 60000)} dk önce` : '—');
async function render() {
  const s = { enabled: true, intervalMin: 5, ...(await chrome.storage.local.get(null)) };
  $('enabled').checked = s.enabled;
  $('interval').value = s.intervalMin;
  $('last').textContent = ago(s.lastPage);
  $('count').textContent = s.lastCount ?? '—';
  $('total').textContent = s.total ?? '—';
  $('full').textContent = s.crawl ? `sürüyor (${s.crawl.pages.length}. sayfa)` : ago(s.lastFull);
  $('agent').textContent = s.agentOk ? 'bağlı' : s.agentOk === false ? 'bağlı değil' : '—';
  $('err').textContent = s.lastError || '';
}
$('enabled').onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$('interval').onchange = (e) => chrome.storage.local.set({ intervalMin: Math.max(2, Number(e.target.value) || 5) });
$('scan').onclick = () => chrome.runtime.sendMessage({ type: 'scanNow' }).then(() => setTimeout(render, 4000));
$('fullBtn').onclick = () => chrome.runtime.sendMessage({ type: 'fullNow' }).then(() => setTimeout(render, 4000));
render();
