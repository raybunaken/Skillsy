// Skillsy service worker - jalur komunikasi client-side AI ke Google Gemini / Groq.
// API key hanya hidup di chrome.storage.local dan tidak pernah di-log.

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return (apiKey || '').trim();
}

function getBaseUrl(apiKey) {
  if (apiKey && apiKey.startsWith('AIza')) {
    return GEMINI_BASE;
  }
  return GROQ_BASE;
}

// Auto-retry untuk rate limit / 429
async function postChatCompletion(body, tries = 4) {
  const apiKey = await getApiKey();
  const baseUrl = getBaseUrl(apiKey);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && tries > 0) {
    let wait = 6000;
    try {
      const msg = (await res.clone().json())?.error?.message || '';
      const m = /try again in ([\d.]+)s/i.exec(msg);
      if (m) wait = Math.ceil(parseFloat(m[1]) * 1000) + 800;
    } catch (_) {}
    await sleep(wait);
    return postChatCompletion(body, tries - 1);
  }
  return res;
}

async function callGroq({ messages, model, temperature = 0.4, maxTokens = 8000 }) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    const err = new Error('API key belum diatur. Masukkan key Google Gemini atau Groq di tab Settings.');
    err.code = 'NO_KEY';
    throw err;
  }
  let targetModel = model;
  if (apiKey.startsWith('AIza') && (!targetModel || !targetModel.startsWith('gemini'))) {
    targetModel = 'gemini-1.5-flash';
  }
  let res;
  try {
    res = await postChatCompletion({
      model: targetModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    });
  } catch (e) {
    throw new Error('Gagal terhubung ke AI provider: ' + e.message);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch (_) {}
    if (res.status === 401) throw new Error('API key ditolak (401). Periksa lagi di tab Settings.');
    if (res.status === 429) throw new Error('Rate limit tercapai (429). Tunggu sebentar lalu coba lagi. ' + detail);
    throw new Error(`Inference error ${res.status}: ${detail || res.statusText}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return parseJsonLoose(content);
}

// Walau json_object mode diminta, model kadang tetap membungkus dengan ```json fence
function parseJsonLoose(text) {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    throw new Error('Model tidak mengembalikan JSON valid. Coba ulangi (generate ulang biasanya memperbaiki).');
  }
}

async function listModels() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key belum diatur.');
  if (apiKey.startsWith('AIza')) {
    return ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'];
  }
  const res = await fetch(`${GROQ_BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Gagal mengambil daftar model (${res.status}).`);
  const data = await res.json();
  return (data.data || [])
    .filter((m) => (m.output_modalities || ['text']).includes('text') && (m.context_window || 0) >= 16000)
    .map((m) => m.id)
    .sort();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'GROQ_JSON') {
        sendResponse({ ok: true, data: await callGroq(msg.payload) });
      } else if (msg.type === 'LIST_MODELS') {
        sendResponse({ ok: true, data: await listModels() });
      } else {
        sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

// Chrome: klik ikon buka side panel. Firefox: klik ikon buka sidebar.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
if (typeof browser !== 'undefined' && browser.sidebarAction) {
  chrome.action.onClicked.addListener(() => {
    try { browser.sidebarAction.open(); } catch (_) {}
  });
}
