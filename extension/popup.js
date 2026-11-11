// Raw Data Collector — popup logic.
// Talks to the content script in the active tab.

const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const dlBtn = document.getElementById('dlBtn');
const clearBtn = document.getElementById('clearBtn');

function setStatus(text, color) {
  statusEl.textContent = text;
  statusEl.style.color = color || 'gray';
}

function setCount(n) {
  countEl.textContent = 'Captured: ' + n;
}

function render(state) {
  setStatus(state.running ? 'Collecting…' : 'Stopped.', state.running ? 'green' : 'gray');
  setCount(state.count || 0);
  startBtn.disabled = !!state.running;
  stopBtn.disabled = !state.running;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function send(action) {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('No active tab.');
  return await chrome.tabs.sendMessage(tab.id, { action: action });
}

async function refresh() {
  try {
    const res = await send('getStatus');
    render(res);
  } catch (e) {
    // Content script not in this page (e.g. page loaded before install,
    // or a chrome:// page). Fall back to stored data.
    try {
      const stored = await chrome.storage.local.get(['rdc_data', 'rdc_state']);
      const data = stored.rdc_data || [];
      render({ running: !!(stored.rdc_state && stored.rdc_state.running), count: data.length });
      setStatus('Content script not in this tab — reload the page.', 'red');
    } catch (e2) {
      setStatus('Could not reach this tab.', 'red');
    }
  }
}

startBtn.addEventListener('click', async () => {
  try {
    await send('start');
    setStatus('Draw a rectangle on the page…', 'orange');
    startBtn.disabled = true;
    stopBtn.disabled = false;
    // The popup closes when the user clicks the page; the rectangle
    // overlay lives in the page itself.
    setTimeout(() => window.close(), 400);
  } catch (e) {
    setStatus('No response — reload the page and try again.', 'red');
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    const res = await send('stop');
    render({ running: false, count: res.count || 0 });
    setStatus('Stopped. .txt downloaded.', 'green');
  } catch (e) {
    setStatus('Could not stop — reload the page.', 'red');
  }
});

dlBtn.addEventListener('click', async () => {
  try {
    const res = await send('download');
    setStatus('Downloaded (' + (res.count || 0) + ' texts).', 'green');
  } catch (e) {
    // Fallback: download from storage directly.
    try {
      const stored = await chrome.storage.local.get(['rdc_data']);
      const data = stored.rdc_data || [];
      if (!data.length) { setStatus('Nothing captured yet.', 'gray'); return; }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 14);
      const body = data.map(c => c.link ? (c.text + ' — ' + c.link) : c.text).join('\n\n') + '\n';
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'raw_data_' + stamp + '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setStatus('Downloaded (' + data.length + ' texts).', 'green');
    } catch (e2) {
      setStatus('Download failed — reload the page.', 'red');
    }
  }
});

clearBtn.addEventListener('click', async () => {
  try {
    await send('clear');
  } catch (e) {
    await chrome.storage.local.set({ rdc_data: [], rdc_state: { running: false, rect: null } });
  }
  render({ running: false, count: 0 });
  setStatus('Cleared.', 'gray');
});

refresh();
