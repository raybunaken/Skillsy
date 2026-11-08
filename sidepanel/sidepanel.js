'use strict';

/* ================================================================
   JobFeast - sidepanel controller
   Alur: Profil (parse CV  JSON)  ambil lowongan dari tab LinkedIn
    generate via Groq (background)  validasi kejujuran  preview
   yang bisa diedit  download PDF (html2pdf).
   ================================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sanitizeFile = (s) =>
  String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);

function showStatus(el, text, kind = 'info') {
  el.textContent = text;
  el.className = 'status ' + (kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : '');
  el.classList.remove('hidden');
}

async function groqJson(messages, model, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type: 'GROQ_JSON', payload: { messages, model, ...extra } });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Service worker tidak merespons.');
  return res.data;
}

/* ================================================================
   PROMPTS - hati dari jaminan kejujuran (berbagi dengan halaman profil,
   definisi persisnya di prompts.js; test e2e mengekstrak dari sana)
   ================================================================ */

const PARSE_SYSTEM = window.JF_PROMPTS.PARSE_SYSTEM;
const GEN_SYSTEM = window.JF_PROMPTS.GEN_SYSTEM;

function genUserPrompt(profile, job) {
  const prefs = profile.preferences || {};
  return `PROFILE (single source of truth):
${JSON.stringify(profile)}

JOB POSTING:
Company: ${job.company}
Title: ${job.title}
Location: ${[job.location, job.workplace].filter(Boolean).join(' · ')}
URL: ${job.url}

Description:
"""
${job.description}
"""

CANDIDATE PREFERENCES (must be respected): tone=${prefs.tone || 'professional'}; avoid mentioning: ${(prefs.avoid || []).join(', ') || '-'}.

Tailor the CV and cover letter now. Return only the JSON.`;
}

/* ================================================================
   STATE
   ================================================================ */

const state = { job: null, gen: null, profile: null, profileRaw: '', activeHistoryItem: null, histSub: 'cv' };
const DEFAULT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];

/* ================================================================
   TABS
   ================================================================ */

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'settings') updateSettingsView();
}

function switchSub(name) {
  $$('.subtab').forEach((t) => t.classList.toggle('active', t.dataset.sub === name));
  $$('.sub').forEach((s) => s.classList.toggle('active', s.id === `sub-${name}`));
  fitAllPreviews();
}

/* ================================================================
   GRAB JOB dari tab LinkedIn aktif
   ================================================================ */

const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

async function grabJob() {
  const st = $('#status');
  showStatus(st, 'Membaca halaman LinkedIn...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('Tidak menemukan tab aktif.');
    const isLinkedIn = /^https:\/\/([a-z-]+\.)?linkedin\.com\//.test(tab.url || '');
    if (!isLinkedIn) {
      throw new Error('Tab aktif bukan halaman LinkedIn. Buka dulu lowongan di LinkedIn, lalu coba lagi.');
    }

    // GET_JOB dibroadcast ke semua frame: frame yang berhasil mengekstrak yang
    // menjawab. Frame atas sendirian tidak cukup karena LinkedIn baru bisa
    // merender detail lowongan di dalam iframe.
    let res = null;
    try {
      res = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB' }), 15000, null);
    } catch (_) {
      // Content script belum ada (umum setelah extension di-reload di tab lama).
      // Self-healing: suntik ulang ke semua frame, lalu coba lagi.
      showStatus(st, 'Menghubungkan ulang Skillsy ke tab ini...');
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content/linkedin.js'] });
        res = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB' }), 15000, null);
      } catch (_) {}
    }

    if (res && res.ok) {
      state.job = res.job;
      renderJob();
      const btnGen = $('#btn-generate');
      btnGen.textContent = `Buat CV + Cover Letter untuk ${res.job.company}`;
      btnGen.classList.add('ready');
      showStatus(st, `Lowongan siap: ${res.job.title} di ${res.job.company}. Lanjut: klik tombol biru di bawah.`, 'ok');
      btnGen.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // Tidak ada frame yang berhasil: ambil diagnostik dari frame atas (selalu menjawab).
    let diag = null;
    try {
      diag = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB_DIAG' }, { frameId: 0 }), 8000, null);
    } catch (_) {}
    const detail = diag && diag.error ? diag.error : 'Gagal membaca lowongan dari semua frame halaman ini.';
    throw new Error(detail);
  } catch (e) {
    let msg = e.message || String(e);
    if (msg.includes('Could not establish connection')) {
      msg = 'Skillsy masih belum bisa terhubung ke tab ini. Muat ulang halaman LinkedIn (tekan F5 di tab LinkedIn), tunggu halaman terbuka penuh, lalu coba lagi.';
    } else if (msg.toLowerCase().includes('cannot access') || msg.toLowerCase().includes('permission')) {
      msg = 'Tidak punya izin membaca tab ini. Pastikan tab LinkedIn yang terbuka adalah halaman lowongan, lalu coba lagi.';
    }
    showStatus(st, msg, 'error');
  }
}

function renderJob() {
  const j = state.job;
  $('#job-info').classList.remove('hidden');
  $('#job-title').textContent = j.title;
  $('#job-meta').textContent = [j.company, j.location, j.workplace].filter(Boolean).join(' · ');
  const desc = $('#job-desc');
  desc.textContent = j.description;
  const countEl = $('#job-char-count');
  if (countEl) countEl.textContent = j.description.length.toLocaleString('id-ID');
}

/* ================================================================
   GENERATE
   ================================================================ */

/* ================================================================
   NORMALISASI HASIL MODEL
   Kadang model mengemas hasil dengan bentuk berbeda (cv sebagai string,
   skills sebagai array, bullets menyatu satu string, pembungkus result).
   Normalisasi ini membuat semua varian tetap bisa dirender, jadi user
   tidak pernah melihat JSON mentah.
   ================================================================ */

function normalizeGeneration(raw, basics) {
  let data = raw && typeof raw === 'object' ? { ...raw } : {};
  if (!data.cv && data.result && typeof data.result === 'object') {
    data = { ...data.result, tailoring_notes: data.tailoring_notes || data.result.tailoring_notes };
  }
  let cv = data.cv;
  if (typeof cv === 'string') {
    try {
      cv = JSON.parse(cv);
    } catch (_) {
      cv = { summary: cv }; // CV free-form satu paragraf: tetap dirender
    }
  }
  if (!cv || typeof cv !== 'object') cv = {};
  if (!cv.summary && !cv.experience && !cv.projects && (raw.summary || raw.experience)) {
    cv = { ...raw };
  }

  let skills = cv.skills;
  if (Array.isArray(skills)) skills = { Skills: skills.filter((s) => typeof s === 'string') };
  else if (typeof skills === 'string') skills = { Skills: skills.split(',').map((s) => s.trim()).filter(Boolean) };
  else if (!skills || typeof skills !== 'object' || Array.isArray(skills)) skills = {};
  cv.skills = skills;

  const normItems = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .filter(Boolean)
      .map((it) => {
        const o = typeof it === 'string' ? { name: it } : { ...it };
        if (typeof o.bullets === 'string') o.bullets = o.bullets.split('\n').map((b) => b.trim()).filter(Boolean);
        if (!Array.isArray(o.bullets)) o.bullets = [];
        return o;
      });
  cv.experience = normItems(cv.experience);
  cv.projects = normItems(cv.projects);
  cv.education = normItems(cv.education);

  const toLines = (v) =>
    typeof v === 'string' ? v.split('\n').map((s) => s.trim()).filter(Boolean) : Array.isArray(v) ? v : [];
  cv.certifications = toLines(cv.certifications);
  if (cv.certifications.length === 1 && cv.certifications[0].includes(',')) {
    cv.certifications = cv.certifications[0].split(',').map((s) => s.trim()).filter(Boolean);
  }
  cv.languages = typeof cv.languages === 'string'
    ? cv.languages.split(',').map((s) => s.trim()).filter(Boolean)
    : Array.isArray(cv.languages) ? cv.languages : [];

  let cl = data.cover_letter;
  if (cl && typeof cl === 'object') cl = cl.text || cl.content || cl.body || '';

  let note = data.recruiter_note;
  if (note && typeof note === 'object') note = note.text || note.content || note.message || '';
  if (!note && typeof data.recruiter_message === 'string') note = data.recruiter_message;

  return { ...data, cv, cover_letter: String(cl || ''), recruiter_note: String(note || ''), basics };
}

/* Versi teks polos CV: untuk tombol copy ke clipboard. */
function cvToPlainText(cv, basics) {
  const b = basics || {};
  const out = [(b.name || '').toUpperCase()];
  if (cv.headline) out.push(cv.headline);
  const contact = [b.location, b.phone, b.email, b.links && b.links.linkedin, b.links && b.links.github, b.links && b.links.portfolio]
    .filter(Boolean)
    .join(' | ');
  if (contact) out.push(contact);

  const section = (title, body) => {
    if (!body || !body.length) return;
    out.push('', title.toUpperCase(), '='.repeat(38));
    out.push(...body);
  };

  section('Professional Summary', cv.summary ? [cv.summary] : []);
  const items = (arr) =>
    arr
      .map((it) => {
        const head = [it.company || it.name || it.institution || '', it.role || it.degree || ''].filter(Boolean).join(' - ');
        const dates = it.dates || [it.start, it.end].filter(Boolean).join(' - ');
        const lines = ['', head + (dates ? ` (${dates})` : '') + (it.location ? `, ${it.location}` : '')];
        (it.bullets || []).forEach((x) => lines.push('- ' + x));
        if (it.details) lines.push(it.details);
        return lines;
      })
      .flat();
  section('Experience', items(cv.experience || []));
  section('Projects', items(cv.projects || []));
  const sk = Object.entries(cv.skills || {}).filter(([, a]) => Array.isArray(a) && a.length);
  section('Skills', sk.map(([k, a]) => `${k}: ${a.join(', ')}`));
  section('Certifications', (cv.certifications || []).length ? [cv.certifications.join(' | ')] : []);
  section('Education', items(cv.education || []));
  section('Languages', (cv.languages || []).length ? [cv.languages.join(', ')] : []);

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* Menyimpan snapshot hasil generate (HTML yang sudah dirender) untuk viewer
   tampilan penuh. Dipanggil lagi saat tombol Tampilan penuh diklik supaya
   hasil suntingan preview ikut terbawa. */
async function saveLastGen() {
  if (!state.gen) return;
  await chrome.storage.local.set({
    lastGen: {
      ts: state.gen.ts || Date.now(),
      job: state.gen.job,
      basics: state.gen.basics || {},
      cvHtml: $('#cv-preview').innerHTML,
      clHtml: $('#cl-preview').innerHTML,
      cvText: cvToPlainText(state.gen.cv, state.gen.basics),
      coverLetterText: $('#cl-preview').innerText,
    },
  });
}

let viewerWindowId = null;

if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((winId) => {
    if (winId === viewerWindowId) {
      viewerWindowId = null;
    }
  });
}

async function launchViewerWindow(doc = 'cv') {
  const viewerUrl = chrome.runtime.getURL('sidepanel/viewer.html?doc=' + encodeURIComponent(doc || 'cv'));

  // 1. Cek apakah jendela popup viewer yang tersimpan masih terbuka
  if (viewerWindowId !== null) {
    try {
      const win = await chrome.windows.get(viewerWindowId, { populate: true });
      if (win) {
        await chrome.windows.update(viewerWindowId, { focused: true });
        if (win.tabs && win.tabs.length > 0) {
          chrome.tabs.sendMessage(win.tabs[0].id, { type: 'RELOAD_DOC' }).catch(() => {});
        }
        return;
      }
    } catch (_) {
      viewerWindowId = null;
    }
  }

  // 2. Cek apakah tab viewer.html sudah ada di window lain
  try {
    const existingTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('sidepanel/viewer.html*') });
    if (existingTabs.length > 0) {
      const tab = existingTabs[0];
      if (tab.windowId) {
        viewerWindowId = tab.windowId;
        await chrome.windows.update(tab.windowId, { focused: true });
        chrome.tabs.sendMessage(tab.id, { type: 'RELOAD_DOC' }).catch(() => {});
        return;
      }
    }
  } catch (_) {}

  // 3. Hitung dimensi popup yang proporsional dan nyaman untuk A4 (~794px + padding)
  const screenW = (window.screen && window.screen.availWidth) || 1280;
  const screenH = (window.screen && window.screen.availHeight) || 800;
  const width = Math.min(1080, Math.max(880, Math.floor(screenW * 0.62)));
  const height = Math.min(960, Math.max(720, Math.floor(screenH * 0.92)));
  // Posisi di sisi kanan layar agar LinkedIn di sisi kiri tetap terlihat
  const left = Math.max(0, screenW - width - 20);
  const top = Math.max(0, Math.floor((screenH - height) / 2));

  try {
    const win = await chrome.windows.create({
      url: viewerUrl,
      type: 'popup',
      width,
      height,
      left,
      top,
      focused: true,
    });
    viewerWindowId = win ? win.id : null;
  } catch (err) {
    console.warn('Fallback ke tab biasa:', err);
    chrome.tabs.create({ url: viewerUrl });
  }
}

async function openViewer(doc) {
  if (!state.gen) return;
  await saveLastGen();
  await launchViewerWindow(doc || 'cv');
}

async function generate() {
  const st = $('#status');
  if (!state.profile) {
    showStatus(st, 'Atur profil kamu dulu di tab Profil.', 'error');
    switchTab('profile');
    return;
  }
  if (!state.job) {
    showStatus(st, 'Ambil lowongan dulu lewat tombol Ambil dari tab LinkedIn ini.', 'error');
    return;
  }
  const model = $('#sel-model').value;
  const lang = $('#sel-lang').value;
  const btn = $('#btn-generate');
  btn.disabled = true;
  showStatus(st, `${model} sedang menyesuaikan CV dan cover letter ke lowongan ini...`);
  try {
    const sys = GEN_SYSTEM.replace('{LANG}', lang);
    const usr = genUserPrompt(state.profile, state.job);
    const raw = await groqJson(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      model,
      { temperature: 0.4, maxTokens: 8000 }
    );
    const data = normalizeGeneration(raw, (state.profile && state.profile.basics) || {});
    const cvHasContent = Boolean(data.cv.summary || (data.cv.experience || []).length || (data.cv.projects || []).length);
    if (!cvHasContent) {
      throw new Error('Hasil generate tidak berisi CV yang bisa dirender. Coba generate ulang.');
    }
    data.job = { title: state.job.title, company: state.job.company, url: state.job.url };
    data.model = model;
    data.lang = lang;
    data.ts = Date.now();
    state.gen = data;
    renderResult();
    saveHistory(data);
    saveLastGen();
    $('#result').scrollIntoView({ behavior: 'smooth' });

    // Langsung jadi PDF: dua file dibuat otomatis setelah generate.
    showStatus(st, 'Selesai. Menyusun dua PDF secara otomatis, mohon tunggu...', 'ok');
    const name = sanitizeFile(data.basics && data.basics.name);
    const comp = sanitizeFile(data.job.company);
    let pdfOk = true;
    try {
      await downloadPdf($('#cv-preview'), `CV - ${name} - ${comp} - ${sanitizeFile(data.job.title)}.pdf`);
    } catch (_) { pdfOk = false; }
    try {
      await downloadPdf($('#cl-preview'), `Cover Letter - ${name} - ${comp}.pdf`);
    } catch (_) { pdfOk = false; }
    let msg = pdfOk
      ? 'Selesai. Dua PDF tersimpan di folder Downloads/Skillsy. Preview tetap bisa diedit, lalu download ulang dari tombol di bawah.'
      : 'Selesai, tapi ada PDF yang gagal dibuat otomatis. Gunakan tombol Download di bawah.';
    if (!data.cover_letter) {
      msg += ' (Catatan: cover letter kosong dari model).';
    }
    showStatus(st, msg, pdfOk ? 'ok' : 'error');
  } catch (e) {
    showStatus(st, e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function corpus() {
  return (state.profileRaw + '\n' + JSON.stringify(state.profile || {})).toLowerCase();
}


function applySidepanelTemplate(tpl) {
  state.template = tpl;
  const cv = $('#cv-preview');
  const cl = $('#cl-preview');
  if (cv) {
    cv.classList.remove('tpl-modern', 'tpl-classic', 'tpl-compact');
    cv.classList.add('tpl-' + tpl);
    ensureOnePage(cv);
  }
  if (cl) {
    cl.classList.remove('tpl-modern', 'tpl-classic', 'tpl-compact');
    cl.classList.add('tpl-' + tpl);
  }
  $$('#sp-tpl-seg button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tpl === tpl));
  fitAllPreviews();
  saveLastGen();
}

function renderResult() {
  const gen = state.gen;
  $('#result').classList.remove('hidden');
  renderFlags(validate(gen, corpus()));
  renderCvInto($('#cv-preview'), gen.cv, gen.basics);
  renderClInto($('#cl-preview'), gen.cover_letter, gen.basics);
  ensureOnePage($('#cv-preview'));
  renderNoteInto($('#recruiter-text'), gen.recruiter_note, gen);
  applySidepanelTemplate(state.template || 'modern');
  fitAllPreviews();
  const notes = (gen.tailoring_notes || []).filter(Boolean);
  if (notes.length) {
    $('#notes').classList.remove('hidden');
    $('#notes').innerHTML =
      '<div class="notes-title">Catatan penyesuaian (apa yang ditekankan & kenapa)</div><ul>' +
      notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>';
  } else {
    $('#notes').classList.add('hidden');
  }
}

/* ================================================================
   VALIDATOR KEJUJURAN
   Layer 2 setelah prompt: angka & skill di hasil generate
   harus bisa ditemukan di profil. Yang tidak ketemu di-flag.
   ================================================================ */

function collectGeneratedText(gen) {
  const parts = [gen.cover_letter || ''];
  const cv = gen.cv || {};
  parts.push(cv.summary || '');
  (cv.experience || []).forEach((x) => (x.bullets || []).forEach((b) => parts.push(String(b))));
  (cv.projects || []).forEach((x) => (x.bullets || []).forEach((b) => parts.push(String(b))));
  return parts.join('\n');
}

function validate(gen, corp) {
  const flags = [];
  const text = collectGeneratedText(gen);

  const patterns = [
    /~?\d+(?:[.,]\d+)?\s*%/gi,                 // 80%, 12.5 %
    /\b\d{1,3}(?:[.,]\d{3})+\+?/g,             // 8,000 / 70.000 / 100,000+
    /\b\d+(?:\.\d+)?x\b/gi,                    // 3x, 2.5x
  ];
  const seen = new Set();
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const norm = m[0].replace(/\s+/g, '').replace(/~/g, '').toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (!corp.includes(norm)) flags.push({ type: 'angka', text: m[0].trim() });
    }
  }

  const cv = gen.cv || {};
  const skillItems = [];
  Object.values(cv.skills || {}).forEach((arr) =>
    (Array.isArray(arr) ? arr : []).forEach((s) => typeof s === 'string' && skillItems.push(s))
  );
  const STOP = new Set(['and', 'for', 'the', 'with', 'basic', 'advanced', 'tools', 'stack']);
  for (const s of skillItems) {
    const tokens = s
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t));
    if (!tokens.length) continue;
    const found = tokens.some((t) => corp.includes(t));
    if (!found) flags.push({ type: 'skill', text: s });
  }
  return flags;
}

const FLAG_TYPE_LABEL = { angka: 'angka', skill: 'skill/tool' };

function renderFlags(flags) {
  const el = $('#flags');
  if (!flags.length) {
    el.className = 'flags hidden';
    el.textContent = '';
    return;
  }
  el.className = 'flags bad';
  el.innerHTML =
    '<b>Catatan:</b> Ada ' +
    (flags.length > 1 ? 'beberapa detail' : 'satu detail') +
    ' yang belum tercatat di profilmu. Kamu bisa menyunting atau menyesuaikannya di editor:' +
    '<ul>' +
    flags.map((f) => `<li>${esc(FLAG_TYPE_LABEL[f.type] || f.type)}: ${esc(f.text)}</li>`).join('') +
    '</ul>';
}

/* ================================================================
   SATU HALAMAN & SKALA PREVIEW
   ensureOnePage: CV dipaksa muat 1 halaman A4 (1123 px @96dpi) lewat
   kompresi tipografi bertahap kalau konten kepanjangan.
   fitAllPreviews: preview A4 (794 px) diskalakan agar muat lebar
   panel supaya bisa dibaca langsung tanpa scroll menyamping.
   ================================================================ */

function ensureOnePage(pageEl) {
  if (!pageEl) return true;
  pageEl.classList.remove('compact', 'compact2');
  pageEl.style.fontSize = '';
  const fits = () => pageEl.scrollHeight <= 1135;
  if (fits()) return true;
  pageEl.classList.add('compact');
  if (fits()) return true;
  pageEl.classList.add('compact2');
  if (fits()) return true;
  // konten ekstrem (mis. setelah edit manual di viewer): turunkan font bertahap
  const base = parseFloat(getComputedStyle(pageEl).fontSize) || 11;
  for (let f = base - 0.3; f >= 8; f -= 0.3) {
    pageEl.style.fontSize = f.toFixed(1) + 'px';
    if (fits()) return true;
  }
  return fits();
}

function fitAllPreviews() {
  $$('.fit-wrap').forEach((wrap) => {
    const inner = wrap.querySelector('.fit-inner');
    const page = inner && inner.firstElementChild;
    if (!inner || !page) return;
    const avail = wrap.clientWidth - 20;
    if (avail <= 0) return;
    const scale = Math.min(1, avail / 794);
    inner.style.transform = scale < 1 ? `scale(${scale})` : 'none';
    wrap.style.height = Math.ceil(page.offsetHeight * scale + 20) + 'px';
  });
}
window.addEventListener('resize', fitAllPreviews);

/* ================================================================
   RENDER CV & COVER LETTER (preview = sumber PDF)
   ================================================================ */

function itemHtml(it) {
  const name = it.company || it.name || it.institution || '';
  const sub = it.role || it.degree || '';
  return (
    '<div class="tcv-item">' +
    `<div class="tcv-row"><span class="tcv-item-title">${esc(name)}</span><span class="tcv-dates">${esc(it.dates || [it.start, it.end].filter(Boolean).join(' - '))}</span></div>` +
    `<div class="tcv-row tcv-sub"><span>${esc(sub)}</span><span>${esc(it.location || '')}</span></div>` +
    (it.bullets && it.bullets.length
      ? '<ul class="tcv-ul">' + it.bullets.map((b) => `<li>${esc(b)}</li>`).join('') + '</ul>'
      : it.details
        ? `<p class="tcv-p">${esc(it.details)}</p>`
        : '') +
    '</div>'
  );
}

function renderCvInto(el, cv, basics) {
  const b = basics || {};
  const contact = [
    b.location,
    b.phone,
    b.email,
    b.links && b.links.linkedin && 'LinkedIn',
    b.links && b.links.github && 'GitHub',
    b.links && b.links.portfolio,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const sec = (title, body) =>
    body ? `<div class="tcv-section"><div class="tcv-sec-title">${esc(title)}</div>${body}</div>` : '';

  let h = `<div class="tcv-name">${esc((b.name || 'Your Name').toUpperCase())}</div>`;
  if (cv.headline) h += `<div class="tcv-headline">${esc(cv.headline)}</div>`;
  if (contact) h += `<div class="tcv-contact">${esc(contact)}</div>`;

  if (cv.summary) h += sec('PROFESSIONAL SUMMARY', `<p class="tcv-p">${esc(cv.summary)}</p>`);
  if (cv.experience && cv.experience.length) h += sec('PROFESSIONAL EXPERIENCE', cv.experience.map(itemHtml).join(''));
  if (cv.projects && cv.projects.length) h += sec('PROJECTS', cv.projects.map(itemHtml).join(''));
  const skills = Object.entries(cv.skills || {}).filter(([, arr]) => Array.isArray(arr) && arr.length);
  if (skills.length) {
    h += sec(
      'SKILLS',
      skills.map(([k, arr]) => `<div class="tcv-skill-row"><b>${esc(k)}:</b> ${arr.map(esc).join(', ')}</div>`).join('')
    );
  }
  if (cv.certifications && cv.certifications.length)
    h += sec('CERTIFICATIONS', `<p class="tcv-p">${cv.certifications.map(esc).join(' · ')}</p>`);
  if (cv.education && cv.education.length) h += sec('EDUCATION', cv.education.map(itemHtml).join(''));
  if (cv.languages && cv.languages.length) h += sec('LANGUAGES', `<p class="tcv-p">${cv.languages.map(esc).join(' · ')}</p>`);

  el.innerHTML = h;
}


function defaultRecruiterNote(gen) {
  const role = gen.job?.title || 'posisi ini';
  const comp = gen.job?.company ? ' di ' + gen.job.company : '';
  return 'Halo, saya tertarik dengan lowongan ' + role + comp + '. Dengan pengalaman saya yang relevan, saya yakin dapat berkontribusi positif. Senang jika bisa terhubung dan berdiskusi lebih lanjut!';
}

function updateNoteCharCount(len) {
  const counter = $('#note-chars');
  if (counter) counter.textContent = len;
  const countWrap = $('#note-count-wrap');
  if (countWrap) {
    countWrap.classList.toggle('over', len > 300);
  }
}

function renderNoteInto(el, note, gen) {
  if (!el) return;
  const content = (note && note.trim()) ? note.trim() : defaultRecruiterNote(gen);
  el.innerText = content;
  updateNoteCharCount(content.length);
}

function renderClInto(el, clText, basics) {
  const b = basics || {};
  const contact = [b.location, b.phone, b.email].filter(Boolean).join(' | ');
  const paras = String(clText || '')
    .split(/\n+/)
    .filter((p) => p.trim());
  el.innerHTML =
    `<div class="tcv-cl-head"><b>${esc(b.name || '')}</b>${contact ? '<br>' + esc(contact) : ''}</div>` +
    paras.map((p) => `<p class="tcv-cl-p">${esc(p)}</p>`).join('');
}

/* ================================================================
   DOWNLOAD PDF
   ================================================================ */

async function downloadPdf(el, filename) {
  const st = $('#status');
  showStatus(st, 'Menyusun PDF, mohon tunggu...');
  // Skala preview harus dilepas dulu supaya PDF ditangkap pada ukuran A4 penuh.
  const inner = el.closest('.fit-inner');
  const prevTransform = inner ? inner.style.transform : null;
  if (inner) inner.style.transform = 'none';
  try {
    const opt = {
      margin: 0,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: 794 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    };
    const worker = html2pdf().set(opt).from(el);
    // Firefox menolak URL data: di downloads API - pakai blob:; fallback data: untuk browser lain.
    let url;
    try {
      const blob = await worker.outputPdf('blob');
      url = URL.createObjectURL(blob);
    } catch (_) {
      url = await worker.outputPdf('datauristring');
    }
    await chrome.downloads.download({
      url,
      filename: `Skillsy/${filename}`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    setTimeout(() => {
      try { if (url.startsWith('blob:')) URL.revokeObjectURL(url); } catch (_) {}
    }, 60000);
    showStatus(st, `Tersimpan di folder Downloads/Skillsy/${filename}.`, 'ok');
  } catch (e) {
    showStatus(st, 'Gagal membuat PDF: ' + e.message, 'error');
  } finally {
    if (inner) inner.style.transform = prevTransform || '';
    fitAllPreviews();
  }
}

/* ================================================================
   HISTORY
   ================================================================ */

async function saveHistory(gen) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift({
    ts: gen.ts,
    job: gen.job,
    model: gen.model,
    lang: gen.lang,
    cv: gen.cv,
    cover_letter: gen.cover_letter,
    recruiter_note: gen.recruiter_note || '',
    status: gen.status || 'Tersimpan',
    basics: gen.basics,
    tailoring_notes: gen.tailoring_notes || [],
  });
  await chrome.storage.local.set({ history: history.slice(0, 100) });
  renderHistory();
}

let historySearchQuery = '';
let historyStatusFilter = 'all';
let historySortOrder = 'newest';

function formatHistoryDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const timeStr = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace('.', ':');
  if (isToday) return 'Hari ini, ' + timeStr;
  if (isYesterday) return 'Kemarin, ' + timeStr;

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  return d.getDate() + ' ' + monthNames[d.getMonth()] + ' ' + d.getFullYear() + ', ' + timeStr;
}

function applyHistoryTemplate(tpl) {
  state.template = tpl;
  const cv = $('#hist-cv-preview');
  const cl = $('#hist-cl-preview');
  if (cv) {
    cv.classList.remove('tpl-modern', 'tpl-classic', 'tpl-compact');
    cv.classList.add('tpl-' + tpl);
    ensureOnePage(cv);
  }
  if (cl) {
    cl.classList.remove('tpl-modern', 'tpl-classic', 'tpl-compact');
    cl.classList.add('tpl-' + tpl);
  }
  $$('#hist-tpl-seg button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tpl === tpl));
  fitAllPreviews();
}

function switchHistSub(sub) {
  state.histSub = sub;
  $$('#hist-subtabs button').forEach((b) => b.classList.toggle('active', b.dataset.hsub === sub));
  $('#hist-sub-cv')?.classList.toggle('hidden', sub !== 'cv');
  $('#hist-sub-cl')?.classList.toggle('hidden', sub !== 'cl');
  $('#hist-sub-note')?.classList.toggle('hidden', sub !== 'note');
  requestAnimationFrame(fitAllPreviews);
  setTimeout(fitAllPreviews, 50);
}

async function showHistoryDetail(ts) {
  const { history = [] } = await chrome.storage.local.get('history');
  const h = history.find((x) => x.ts === Number(ts));
  if (!h) return;

  state.activeHistoryItem = h;
  const basics = (h.basics && h.basics.name) ? h.basics : (state.profile?.basics || {});

  // Header info
  const titleEl = $('#hist-det-title');
  if (titleEl) titleEl.textContent = h.job?.title || 'Posisi Lowongan';

  const compEl = $('#hist-det-company');
  if (compEl) compEl.textContent = h.job?.company || '-';

  const dateEl = $('#hist-det-date');
  if (dateEl) dateEl.textContent = formatHistoryDate(h.ts);

  const jobLink = $('#hist-det-joblink');
  if (jobLink) {
    if (h.job?.url) {
      jobLink.href = h.job.url;
      jobLink.classList.remove('hidden');
    } else {
      jobLink.classList.add('hidden');
    }
  }

  // Status select
  const stSel = $('#hist-det-status-sel');
  if (stSel) {
    const curSt = h.status || 'Tersimpan';
    stSel.value = curSt;
    stSel.className = 'status-select st-' + curSt.toLowerCase();
  }

  // Template
  const tpl = state.template || 'modern';
  applyHistoryTemplate(tpl);

  // Render CV & CL
  renderCvInto($('#hist-cv-preview'), h.cv || {}, basics);
  ensureOnePage($('#hist-cv-preview'));

  renderClInto($('#hist-cl-preview'), h.cover_letter || '', basics);

  // Note
  const note = (h.recruiter_note && h.recruiter_note.trim()) ? h.recruiter_note.trim() : defaultRecruiterNote(h);
  const noteEl = $('#hist-note-text');
  if (noteEl) {
    noteEl.innerText = note;
    const charEl = $('#hist-note-chars');
    if (charEl) charEl.textContent = note.length;
    $('#hist-note-count-wrap')?.classList.toggle('over', note.length > 300);
  }

  // Tailoring notes
  const notes = (h.tailoring_notes || []).filter(Boolean);
  const notesEl = $('#hist-tailoring-notes');
  if (notesEl) {
    if (notes.length) {
      notesEl.classList.remove('hidden');
      notesEl.innerHTML =
        '<div class="notes-title">Catatan penyesuaian (apa yang ditekankan & kenapa)</div><ul>' +
        notes.map((n) => `<li>${esc(n)}</li>`).join('') + '</ul>';
    } else {
      notesEl.classList.add('hidden');
    }
  }

  // Default to CV subtab
  switchHistSub('cv');

  // Toggle views
  $('#hist-list-view')?.classList.add('hidden');
  $('#hist-detail-view')?.classList.remove('hidden');

  requestAnimationFrame(fitAllPreviews);
  setTimeout(fitAllPreviews, 60);

  const tabHist = $('#tab-history');
  if (tabHist) tabHist.scrollTop = 0;
}

function hideHistoryDetail() {
  state.activeHistoryItem = null;
  $('#hist-detail-view')?.classList.add('hidden');
  $('#hist-list-view')?.classList.remove('hidden');
  renderHistory();
}

const STATUSES = ['Tersimpan', 'Terkirim', 'Interview', 'Diterima', 'Ditolak'];

function renderHistory() {
  chrome.storage.local.get('history', ({ history = [] }) => {
    const list = $('#history-list');
    const countBadge = $('#history-count');
    if (countBadge) countBadge.textContent = history.length;

    if (!history.length) {
      list.innerHTML = '<p class="hint history-empty-hint">Belum ada riwayat lamaran.</p>';
      return;
    }

    const q = historySearchQuery.trim().toLowerCase();
    const filtered = history.filter((h) => {
      if (historyStatusFilter !== 'all') {
        const itemStatus = (h.status || 'Tersimpan').toLowerCase();
        if (itemStatus !== historyStatusFilter.toLowerCase()) return false;
      }
      if (!q) return true;
      const title = (h.job?.title || '').toLowerCase();
      const comp = (h.job?.company || '').toLowerCase();
      return title.includes(q) || comp.includes(q);
    });

    filtered.sort((a, b) => {
      if (historySortOrder === 'oldest') {
        return (a.ts || 0) - (b.ts || 0);
      }
      return (b.ts || 0) - (a.ts || 0);
    });

    if (!filtered.length) {
      list.innerHTML = '<p class="hint history-empty-hint">Tidak ada lowongan yang cocok dengan filter atau pencarian.</p>';
      return;
    }

    list.innerHTML = filtered
      .map(
        (h) => {
          const st = h.status || 'Tersimpan';
          const stClass = 'st-' + st.toLowerCase();
          const options = STATUSES.map(
            (s) => `<option value="${s}" ${s === st ? 'selected' : ''}>${s}</option>`
          ).join('');
          const modelShort = h.model ? (h.model.split('/')[1] || h.model) : '';
          const jobUrl = h.job?.url || '';
          return `
        <div class="history-item" data-ts="${h.ts}">
          <div class="h-top">
            <span class="h-date">${formatHistoryDate(h.ts)}</span>
            <select class="status-select ${stClass}" data-ts="${h.ts}" title="Ubah status lamaran">
              ${options}
            </select>
          </div>
          <div class="h-body">
            <div class="h-job-title" data-act="view-doc" data-ts="${h.ts}" title="Klik untuk lihat dokumen lengkap di sini">${esc(h.job?.title || 'Posisi Lowongan')}</div>
            <div class="h-company-line">
              <span class="h-company-name">${esc(h.job?.company || '-')}</span>
              ${jobUrl ? `<a href="${esc(jobUrl)}" target="_blank" rel="noopener noreferrer" class="h-link-job" title="Buka lowongan asli di LinkedIn">Buka lowongan &#8599;</a>` : ''}
            </div>
          </div>
          <div class="h-bottom">
            <span class="h-model-chip">${esc(modelShort)}</span>
            <div class="h-actions">
              <button type="button" class="h-btn-action primary" data-act="view-doc" data-ts="${h.ts}" title="Buka dan baca dokumen lengkap di sini">Lihat</button>
              <button type="button" class="h-btn-action" data-act="dl-pdf" data-ts="${h.ts}" title="Download PDF CV langsung">PDF</button>
              <button type="button" class="h-btn-action" data-act="copy-note" data-ts="${h.ts}" title="Copy pesan singkat ke rekruter">Pesan HR</button>
              <button type="button" class="h-del-btn" data-act="del" data-ts="${h.ts}" title="Hapus dari riwayat">Hapus</button>
            </div>
          </div>
        </div>`;
        }
      )
      .join('');
  });
}


async function openHistoryInViewer(ts) {
  const { history = [] } = await chrome.storage.local.get('history');
  const h = history.find((x) => x.ts === Number(ts));
  if (!h) return;

  const basics = (h.basics && h.basics.name) ? h.basics : (state.profile?.basics || {});
  const tempCvEl = document.createElement('div');
  const tempClEl = document.createElement('div');
  renderCvInto(tempCvEl, h.cv || {}, basics);
  renderClInto(tempClEl, h.cover_letter || '', basics);

  const lastGen = {
    ts: h.ts,
    job: h.job,
    basics,
    model: h.model,
    lang: h.lang,
    cv: h.cv,
    cover_letter: h.cover_letter,
    recruiter_note: h.recruiter_note || '',
    cvHtml: tempCvEl.innerHTML,
    clHtml: tempClEl.innerHTML,
    status: h.status || 'Tersimpan',
  };

  // 1. Simpan ke lastGen
  await chrome.storage.local.set({ lastGen });

  // 2. Buka di jendela popup mandiri (LinkedIn tetap aktif)
  await launchViewerWindow('cv');

  showStatus($('#status'), 'Membuka dokumen: ' + (h.job?.title || 'Lowongan') + ' di ' + (h.job?.company || ''), 'ok');
}

async function downloadHistoryPdf(ts) {
  const { history = [] } = await chrome.storage.local.get('history');
  const h = history.find((x) => x.ts === Number(ts));
  if (!h) return;

  const st = $('#status');
  showStatus(st, 'Menyusun PDF untuk ' + (h.job?.title || 'CV') + '...', 'info');

  const basics = (h.basics && h.basics.name) ? h.basics : (state.profile?.basics || {});
  const tempCvEl = document.createElement('div');
  tempCvEl.className = 'tcv-cv tpl-' + (state.template || 'modern');
  tempCvEl.style.width = '794px';
  tempCvEl.style.position = 'absolute';
  tempCvEl.style.left = '-9999px';
  tempCvEl.style.top = '0';
  document.body.appendChild(tempCvEl);

  renderCvInto(tempCvEl, h.cv || {}, basics);

  try {
    const filename = 'CV - ' + sanitizeFile(basics.name || 'Skillsy') + ' - ' + sanitizeFile(h.job?.company || 'Lowongan') + '.pdf';
    await downloadPdf(tempCvEl, filename);
  } catch (e) {
    showStatus(st, 'Gagal membuat PDF: ' + e.message, 'error');
  } finally {
    tempCvEl.remove();
  }
}

async function copyHistoryNote(ts, targetBtn) {
  const { history = [] } = await chrome.storage.local.get('history');
  const h = history.find((x) => x.ts === Number(ts));
  if (!h) return;

  const note = (h.recruiter_note && h.recruiter_note.trim())
    ? h.recruiter_note.trim()
    : defaultRecruiterNote(h);

  try {
    await navigator.clipboard.writeText(note);
    if (targetBtn) {
      const prevText = targetBtn.textContent;
      targetBtn.textContent = 'Tersalin';
      setTimeout(() => (targetBtn.textContent = prevText), 1500);
    }
    showStatus($('#status'), 'Pesan HR tersalin ke clipboard.', 'ok');
  } catch (e) {
    showStatus($('#status'), 'Gagal menyalin pesan: ' + e.message, 'error');
  }
}

function openHistory(ts) {
  chrome.storage.local.get('history', ({ history = [] }) => {
    const h = history.find((x) => x.ts === ts);
    if (!h) return;
    state.gen = {
      cv: h.cv,
      cover_letter: h.cover_letter,
      recruiter_note: h.recruiter_note || '',
      status: h.status || 'Tersimpan',
      basics: (h.basics && h.basics.name) ? h.basics : (state.profile?.basics || {}),
      job: h.job,
      tailoring_notes: h.tailoring_notes,
      model: h.model,
      ts: h.ts,
    };
    state.job = h.job;
    renderJob();
    renderResult();
    saveLastGen();
    switchTab('generate');
    const st = $('#status');
    if (st) showStatus(st, 'Riwayat dibuka: ' + (h.job?.title || 'Lowongan') + ' di ' + (h.job?.company || ''), 'ok');
    $('#result').scrollIntoView({ behavior: 'smooth' });
  });
}

/* ================================================================
   PROFILE: upload PDF / paste / parse / edit / import-export
   ================================================================ */

async function handleCvFile(file) {
  const st = $('#parse-status');
  showStatus(st, 'Membuka PDF kamu...');
  try {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      text += tc.items.map((it) => it.str).join(' ') + '\n';
    }
    $('#raw-text').value = text.trim();
    showStatus(st, `CV kamu terbaca (${doc.numPages} halaman). Sekarang klik tombol Baca CV saya.`, 'ok');
  } catch (e) {
    showStatus(st, 'File PDF-nya tidak bisa dibuka. Coba pilih file lain, atau tempel isi CV di kolom teks bawah.', 'error');
  }
}

async function parseProfile() {
  const st = $('#parse-status');
  const raw = $('#raw-text').value.trim();
  if (raw.length < 100) {
    showStatus(st, 'Isi CV-nya belum ada. Pilih file PDF CV kamu dulu, atau tempel isinya di kolom teks.', 'error');
    return;
  }
  const model = $('#sel-model').value;
  showStatus(st, `${model} sedang membaca CV kamu, sebentar saja...`);
  try {
    const data = await groqJson(
      [
        { role: 'system', content: PARSE_SYSTEM },
        { role: 'user', content: `CV text:\n"""\n${raw}\n"""\nExtract to JSON now.` },
      ],
      model,
      { temperature: 0.1, maxTokens: 6000 }
    );
    if (!data.basics || !data.basics.name) throw new Error('CV belum terbaca dengan benar. Coba sekali lagi, atau pakai tab Isi manual.');
    $('#profile-json').value = JSON.stringify(data, null, 2);
    await saveProfile(data, raw);
    showStatus(st, `Selesai. Profil ${data.basics.name} sudah siap dipakai. Lanjut ke tab Generate.`, 'ok');
  } catch (e) {
    showStatus(st, e.message, 'error');
  }
}

async function saveProfile(profile, raw) {
  state.profile = profile;
  if (typeof raw === 'string' && raw.trim()) state.profileRaw = raw.trim();
  await chrome.storage.local.set({ profile, profileRaw: state.profileRaw });
  updateProfileMeta();
  updateBanner();
}

function updateProfileStrip() {
  const strip = $('#gen-profile-strip');
  const txt = $('#strip-text');
  if (!strip) return;
  const p = state.profile;
  if (p && p.basics && p.basics.name) {
    strip.classList.remove('hidden');
    txt.textContent = `Profil aktif: ${p.basics.name}`;
  } else {
    strip.classList.add('hidden');
  }
}

function updateAdvSummary() {
  const el = $('#adv-summary-text');
  if (!el) return;
  const lang = state.lang || 'English';
  const m = state.model ? getFriendlyModelLabel(state.model) : 'default';
  el.textContent = `${lang} · ${m}`;
}

function updateBanner() {
  $('#no-profile-banner').classList.toggle('hidden', Boolean(state.profile));
  updateProfileStrip();
  updateAdvSummary();
}

function updateProfileMeta() {
  const el = $('#profile-meta');
  if (!state.profile) {
    el.textContent = '';
    return;
  }
  const p = state.profile;
  const count = (a) => (Array.isArray(a) ? a.length : 0);
  el.textContent =
    `Aktif: ${p.basics?.name || '(tanpa nama)'} · ` +
    `${count(p.experience)} pengalaman · ${count(p.projects)} proyek · ` +
    `${Object.values(p.skills || {}).reduce((n, a) => n + count(a), 0)} skill · ` +
    `${state.profileRaw ? state.profileRaw.length.toLocaleString('id-ID') : 0} karakter teks asal (korpus validator).`;
}

// Ringkasan status profil di tab Profil: kalau sudah ada profil, tampilkan
// kartu identitas + pintu ke editor halaman penuh; kalau belum, tampilkan
// dua pilihan awal. Dipanggil ulang tiap storage berubah (mis. dari editor).
function renderProfileStatus() {
  const p = state.profile;
  $('#profile-active').classList.toggle('hidden', !p);
  $('#profile-empty').classList.toggle('hidden', Boolean(p));
  if (!p) return;
  const count = (a) => (Array.isArray(a) ? a.length : 0);
  $('#p-name').textContent = p.basics?.name || '(tanpa nama)';
  $('#p-initial').textContent = (p.basics?.name || '?').trim().charAt(0).toUpperCase();
  const headline = (p.basics?.headline_options && p.basics.headline_options[0]) || '';
  const hlEl = $('#p-headline');
  if (hlEl) hlEl.textContent = headline;

  if ($('#badge-exp')) $('#badge-exp').textContent = `${count(p.experience)} Pengalaman`;
  if ($('#badge-proj')) $('#badge-proj').textContent = `${count(p.projects)} Proyek`;
  if ($('#badge-skills')) $('#badge-skills').textContent = `${Object.values(p.skills || {}).reduce((n, a) => n + count(a), 0)} Skill`;
  if ($('#badge-edu')) $('#badge-edu').textContent = `${count(p.education)} Pendidikan`;
}

function openProfileEditor() {
  chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/profile.html') });
}

async function exportProfile() {
  if (!state.profile) return;
  const blob = new Blob([JSON.stringify(state.profile, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `Skillsy/profile-${sanitizeFile(state.profile.basics?.name || 'me')}.json`,
    saveAs: true,
  });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function importProfile(file) {
  const st = $('#parse-status');
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.basics) throw new Error('File tidak berupa profil Skillsy (tidak ada field "basics").');
    $('#profile-json').value = JSON.stringify(data, null, 2);
    await saveProfile(data, null);
    showStatus(st, 'Profil diimpor.', 'ok');
  } catch (e) {
    showStatus(st, 'Gagal impor: ' + e.message, 'error');
  }
}

/* ================================================================
   SETTINGS & PREFERENCES
   ================================================================ */

function getFriendlyModelLabel(modelId) {
  const map = {
    'openai/gpt-oss-120b': 'gpt-oss-120b (Kualitas Terbaik)',
    'openai/gpt-oss-20b': 'gpt-oss-20b (Cepat & Hemat)',
    'qwen/qwen3.8-27b': 'qwen3.8-27b (Optimal Bahasa Indonesia)',
    'llama-3.3-70b-versatile': 'llama-3.3-70b (Cepat & Akurat)',
    'llama-3.1-8b-instant': 'llama-3.1-8b (Super Cepat)',
    'mixtral-8x7b-32768': 'mixtral-8x7b (Multilingual)',
  };
  if (map[modelId]) return map[modelId];
  return modelId.includes('/') ? modelId.split('/')[1] : modelId;
}

function fillModelSelect(models) {
  const sel = $('#sel-model');
  if (!sel) return;
  const prev = sel.value;
  const list = (models && models.length ? models : DEFAULT_MODELS).filter((m, i, a) => a.indexOf(m) === i);
  if (!list.includes(prev) && prev) list.unshift(prev);
  sel.innerHTML = list.map((m) => `<option value="${esc(m)}">${esc(getFriendlyModelLabel(m))}</option>`).join('');
  if (list.includes(prev)) sel.value = prev;
  fillSettingsModelSelect(models);
}

function fillSettingsModelSelect(models) {
  const sel = $('#stg-model');
  if (!sel) return;
  const prev = sel.value || state.model;
  const list = (models && models.length ? models : DEFAULT_MODELS).filter((m, i, a) => a.indexOf(m) === i);
  if (!list.includes(prev) && prev) list.unshift(prev);
  sel.innerHTML = list.map((m) => `<option value="${esc(m)}">${esc(getFriendlyModelLabel(m))}</option>`).join('');
  if (list.includes(prev)) sel.value = prev;
}

async function refreshModelsFromApi() {
  const st = $('#key-status');
  showStatus(st, 'Mengambil daftar model dari Groq...');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'LIST_MODELS' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Gagal mengambil model.');
    await chrome.storage.local.set({ models: res.data });
    fillModelSelect(res.data);
    fillSettingsModelSelect(res.data);
    showStatus(st, `Berhasil memperbarui: ${res.data.length} model tersedia.`, 'ok');
  } catch (e) {
    showStatus(st, e.message, 'error');
  }
}

async function updateSettingsView() {
  const store = await chrome.storage.local.get(['apiKey', 'model', 'lang', 'profile', 'history', 'cvTemplate', 'models']);

  // 1. API key status & input
  const key = store.apiKey || '';
  const inp = $('#inp-key');
  if (inp && document.activeElement !== inp) {
    inp.value = key;
  }
  $('#btn-clear-key')?.classList.toggle('hidden', !(inp && inp.value.length));

  const badge = $('#api-key-badge');
  const testBtn = $('#btn-test-key');
  if (badge) {
    if (key) {
      badge.textContent = '● Tersimpan';
      badge.className = 'badge-pill info';
      testBtn?.classList.remove('hidden');
    } else {
      badge.textContent = '○ Belum Disetel';
      badge.className = 'badge-pill warn';
      testBtn?.classList.add('hidden');
    }
  }

  // 2. Models & preferences
  fillSettingsModelSelect(store.models);
  const curModel = store.model || state.model || 'openai/gpt-oss-20b';
  if ($('#stg-model')) $('#stg-model').value = curModel;

  const curLang = store.lang || state.lang || 'English';
  $$('#stg-lang-seg button').forEach((b) => b.classList.toggle('active', b.dataset.lang === curLang));

  const curTpl = store.cvTemplate || state.template || 'modern';
  $$('#stg-tpl-seg button').forEach((b) => b.classList.toggle('active', b.dataset.tpl === curTpl));

  // 3. Storage statistics
  const prof = store.profile;
  const profStat = $('#stg-stat-profile');
  if (profStat) {
    if (prof && prof.basics && prof.basics.name) {
      const expCount = (prof.experience || []).length;
      profStat.textContent = `${prof.basics.name} (${expCount} pengalaman)`;
    } else {
      profStat.textContent = 'Belum ada profil';
    }
  }

  const histStat = $('#stg-stat-history');
  if (histStat) {
    const hist = store.history || [];
    histStat.textContent = `${hist.length} lowongan`;
  }
}

async function saveAndTestKey() {
  const inp = $('#inp-key');
  const val = inp ? inp.value.trim() : '';
  const st = $('#key-status');
  const badge = $('#api-key-badge');
  const btn = $('#btn-save-key');

  if (!val) {
    await chrome.storage.local.set({ apiKey: '' });
    if (badge) {
      badge.textContent = '○ Belum Disetel';
      badge.className = 'badge-pill warn';
    }
    showStatus(st, 'API key telah dikosongkan.', 'ok');
    $('#btn-test-key')?.classList.add('hidden');
    updateBanner();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Memverifikasi...';
  showStatus(st, 'Menyimpan dan menguji koneksi ke Groq...');
  if (badge) {
    badge.textContent = '● Memeriksa...';
    badge.className = 'badge-pill info';
  }

  try {
    await chrome.storage.local.set({ apiKey: val });
    const res = await chrome.runtime.sendMessage({ type: 'LIST_MODELS' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Gagal terhubung ke Groq.');

    if (badge) {
      badge.textContent = '● Aktif';
      badge.className = 'badge-pill ok';
    }
    showStatus(st, `Tersambung ke Groq. ${res.data.length} model siap digunakan.`, 'ok');
    $('#btn-test-key')?.classList.remove('hidden');
    await chrome.storage.local.set({ models: res.data });
    fillModelSelect(res.data);
    fillSettingsModelSelect(res.data);
    updateBanner();
  } catch (e) {
    if (badge) {
      badge.textContent = '● Ditolak';
      badge.className = 'badge-pill warn';
    }
    showStatus(st, 'Koneksi gagal: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan & Verifikasi';
  }
}

async function testKey() {
  const st = $('#key-status');
  const badge = $('#api-key-badge');
  const btn = $('#btn-test-key');

  const currentInput = $('#inp-key') ? $('#inp-key').value.trim() : '';
  if (currentInput) {
    await chrome.storage.local.set({ apiKey: currentInput });
  }

  if (btn) btn.disabled = true;
  showStatus(st, 'Menguji koneksi ke Groq...');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'LIST_MODELS' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Gagal.');
    if (badge) {
      badge.textContent = '● Aktif';
      badge.className = 'badge-pill ok';
    }
    showStatus(st, `Koneksi stabil. ${res.data.length} model siap digunakan.`, 'ok');
  } catch (e) {
    if (badge) {
      badge.textContent = '● Error';
      badge.className = 'badge-pill warn';
    }
    showStatus(st, 'Koneksi gagal: ' + e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ================================================================
   INIT
   ================================================================ */

async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

  const store = await chrome.storage.local.get(['apiKey', 'model', 'lang', 'profile', 'profileRaw', 'models', 'history', 'cvTemplate']);
  state.template = store.cvTemplate || 'modern';
  state.profile = store.profile || null;
  state.profileRaw = store.profileRaw || '';
  $('#inp-key').value = store.apiKey || '';
  fillModelSelect(store.models);
  if (store.model) $('#sel-model').value = store.model;
  if (store.lang) $('#sel-lang').value = store.lang;
  if (state.profile) $('#profile-json').value = JSON.stringify(state.profile, null, 2);
  updateBanner();
  updateProfileMeta();
  renderProfileStatus();
  renderHistory();

  // tabs
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $$('.subtab').forEach((t) => t.addEventListener('click', () => switchSub(t.dataset.sub)));
  $('#goto-profile').addEventListener('click', (e) => {
    e.preventDefault();
    switchTab('profile');
  });

  // generate tab
  $('#strip-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    switchTab('profile');
  });
  $('#btn-grab').addEventListener('click', grabJob);
  $('#btn-desc-more')?.addEventListener('click', () => {
    const desc = $('#job-desc');
    if (!desc) return;
    const expanded = desc.classList.toggle('expanded');
    $('#btn-desc-more').textContent = expanded ? 'Tutup deskripsi' : 'Lihat deskripsi lengkap';
  });
  $('#btn-generate').addEventListener('click', generate);
  $('#sel-model').addEventListener('change', (e) => {
    state.model = e.target.value;
    if ($('#stg-model')) $('#stg-model').value = e.target.value;
    updateAdvSummary();
    chrome.storage.local.set({ model: e.target.value });
  });
  $('#sel-lang').addEventListener('change', (e) => {
    state.lang = e.target.value;
    $$('#stg-lang-seg button').forEach((b) => b.classList.toggle('active', b.dataset.lang === e.target.value));
    updateAdvSummary();
    chrome.storage.local.set({ lang: e.target.value });
  });
  $('#btn-dl-cv').addEventListener('click', () => {
    const g = state.gen;
    if (!g) return;
    downloadPdf($('#cv-preview'), `CV - ${sanitizeFile(g.basics?.name)} - ${sanitizeFile(g.job?.company)} - ${sanitizeFile(g.job?.title)}.pdf`);
  });
  $('#btn-dl-cl').addEventListener('click', () => {
    const g = state.gen;
    if (!g) return;
    downloadPdf($('#cl-preview'), `Cover Letter - ${sanitizeFile(g.basics?.name)} - ${sanitizeFile(g.job?.company)}.pdf`);
  });
  $('#btn-copy-cl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#cl-preview').innerText);
      showStatus($('#status'), 'Cover letter tersalin ke clipboard.', 'ok');
    } catch (e) {
      showStatus($('#status'), 'Gagal copy: ' + e.message, 'error');
    }
  });
  $('#btn-copy-cv').addEventListener('click', async () => {
    if (!state.gen) return;
    try {
      await navigator.clipboard.writeText(cvToPlainText(state.gen.cv, state.gen.basics));
      showStatus($('#status'), 'Teks CV tersalin ke clipboard.', 'ok');
    } catch (e) {
      showStatus($('#status'), 'Gagal copy: ' + e.message, 'error');
    }
  });
  $$('.open-viewer').forEach((b) =>
    b.addEventListener('click', () => openViewer(b.dataset.doc))
  );

  
  // sidepanel template switcher
  $$('#sp-tpl-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = btn.dataset.tpl;
      applySidepanelTemplate(tpl);
      chrome.storage.local.set({ cvTemplate: tpl });
    });
  });

  // profile tab
  $('#btn-open-editor').addEventListener('click', openProfileEditor);
  $('#btn-export-quick')?.addEventListener('click', exportProfile);
  $('#btn-open-editor-empty').addEventListener('click', openProfileEditor);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.profile) {
      state.profile = changes.profile.newValue || null;
      updateBanner();
      renderProfileStatus();
      if (state.profile) $('#profile-json').value = JSON.stringify(state.profile, null, 2);
    }
    if (changes.profileRaw) state.profileRaw = changes.profileRaw.newValue || '';
  });
  $('#file-cv').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      const name = e.target.files[0].name;
      $('#file-cv-label').textContent = name.length > 30 ? name.slice(0, 27) + '...' : name;
      handleCvFile(e.target.files[0]);
    }
  });
  $('#btn-parse').addEventListener('click', parseProfile);
  $('#btn-save-profile').addEventListener('click', async () => {
    const st = $('#parse-status');
    try {
      const data = JSON.parse($('#profile-json').value);
      await saveProfile(data, null);
      showStatus(st, 'Profil disimpan.', 'ok');
    } catch (e) {
      showStatus(st, 'JSON tidak valid: ' + e.message, 'error');
    }
  });
  $('#btn-export-profile').addEventListener('click', exportProfile);
  $('#file-import').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importProfile(e.target.files[0]);
  });


  // recruiter note listeners
  $('#recruiter-text')?.addEventListener('input', (e) => {
    const text = e.target.innerText || '';
    if (state.gen) state.gen.recruiter_note = text;
    updateNoteCharCount(text.length);
  });

  $('#btn-copy-note')?.addEventListener('click', async () => {
    const text = $('#recruiter-text')?.innerText || '';
    try {
      await navigator.clipboard.writeText(text);
      showStatus($('#status'), 'Pesan HR tersalin ke clipboard.', 'ok');
      const b = $('#btn-copy-note');
      b.textContent = 'Tersalin';
      setTimeout(() => (b.textContent = 'Copy pesan'), 1500);
    } catch (e) {
      showStatus($('#status'), 'Gagal copy: ' + e.message, 'error');
    }
  });

  // history search, sort & filter
  $('#history-search')?.addEventListener('input', (e) => {
    historySearchQuery = e.target.value;
    $('#btn-clear-search')?.classList.toggle('hidden', !historySearchQuery);
    renderHistory();
  });

  $('#btn-clear-search')?.addEventListener('click', () => {
    const input = $('#history-search');
    if (input) input.value = '';
    historySearchQuery = '';
    $('#btn-clear-search')?.classList.add('hidden');
    renderHistory();
  });

  $('#history-sort')?.addEventListener('change', (e) => {
    historySortOrder = e.target.value;
    renderHistory();
  });

  // Delegasi event klik filter tab
  $('#history-filter-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.h-filter-btn');
    if (!btn) return;
    $$('.h-filter-btn', $('#history-filter-bar')).forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    historyStatusFilter = btn.dataset.filter || 'all';
    renderHistory();
  });

  // history status select change
  $('#history-list').addEventListener('change', (e) => {
    const sel = e.target.closest('select.status-select');
    if (!sel) return;
    const ts = Number(sel.dataset.ts);
    const newStatus = sel.value;
    chrome.storage.local.get('history', ({ history = [] }) => {
      const item = history.find((x) => x.ts === ts);
      if (item) {
        item.status = newStatus;
        chrome.storage.local.set({ history }, renderHistory);
      }
    });
  });

  // history tab clicks (Lihat Dokumen / Download PDF / Copy Pesan HR / Hapus)
  $('#history-list').addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    if (!actEl) {
      const card = e.target.closest('.history-item');
      if (card && !e.target.closest('select, a, button')) {
        const ts = Number(card.dataset.ts);
        if (ts) showHistoryDetail(ts);
      }
      return;
    }
    const ts = Number(actEl.dataset.ts);
    if (actEl.dataset.act === 'view-doc') {
      showHistoryDetail(ts);
    } else if (actEl.dataset.act === 'dl-pdf') {
      downloadHistoryPdf(ts);
    } else if (actEl.dataset.act === 'copy-note') {
      copyHistoryNote(ts, actEl);
    } else if (actEl.dataset.act === 'open') {
      openHistory(ts);
    } else if (actEl.dataset.act === 'del') {
      if (!confirm('Hapus riwayat lowongan ini?')) return;
      chrome.storage.local.get('history', ({ history = [] }) => {
        const updated = history.filter((x) => x.ts !== ts);
        chrome.storage.local.set({ history: updated }, renderHistory);
      });
    }
  });

  // history detail view event listeners
  $('#btn-hist-back')?.addEventListener('click', hideHistoryDetail);

  $('#hist-det-status-sel')?.addEventListener('change', (e) => {
    const newStatus = e.target.value;
    e.target.className = 'status-select st-' + newStatus.toLowerCase();
    if (state.activeHistoryItem) {
      state.activeHistoryItem.status = newStatus;
      const ts = state.activeHistoryItem.ts;
      chrome.storage.local.get('history', ({ history = [] }) => {
        const item = history.find((x) => x.ts === ts);
        if (item) {
          item.status = newStatus;
          chrome.storage.local.set({ history });
        }
      });
    }
  });

  $('#btn-hist-open-viewer')?.addEventListener('click', () => {
    if (state.activeHistoryItem) {
      openHistoryInViewer(state.activeHistoryItem.ts);
    }
  });

  $$('#hist-tpl-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = btn.dataset.tpl;
      state.template = tpl;
      applyHistoryTemplate(tpl);
      applySidepanelTemplate(tpl);
      chrome.storage.local.set({ cvTemplate: tpl });
    });
  });

  $$('#hist-subtabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchHistSub(btn.dataset.hsub));
  });

  $('#btn-hist-dl-cv')?.addEventListener('click', () => {
    const h = state.activeHistoryItem;
    if (!h) return;
    const basics = (h.basics && h.basics.name) ? h.basics : (state.profile?.basics || {});
    downloadPdf($('#hist-cv-preview'), `CV - ${sanitizeFile(basics.name)} - ${sanitizeFile(h.job?.company)} - ${sanitizeFile(h.job?.title)}.pdf`);
  });

  $('#btn-hist-copy-cv')?.addEventListener('click', async () => {
    const h = state.activeHistoryItem;
    if (!h) return;
    const basics = (h.basics && h.basics.name) ? h.basics : (state.profile?.basics || {});
    try {
      await navigator.clipboard.writeText(cvToPlainText(h.cv, basics));
      showStatus($('#status'), 'Teks CV tersalin ke clipboard.', 'ok');
    } catch (e) {
      showStatus($('#status'), 'Gagal copy: ' + e.message, 'error');
    }
  });

  $('#btn-hist-dl-cl')?.addEventListener('click', () => {
    const h = state.activeHistoryItem;
    if (!h) return;
    const basics = (h.basics && h.basics.name) ? h.basics : (state.profile?.basics || {});
    downloadPdf($('#hist-cl-preview'), `Cover Letter - ${sanitizeFile(basics.name)} - ${sanitizeFile(h.job?.company)}.pdf`);
  });

  $('#btn-hist-copy-cl')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#hist-cl-preview').innerText);
      showStatus($('#status'), 'Cover letter tersalin ke clipboard.', 'ok');
    } catch (e) {
      showStatus($('#status'), 'Gagal copy: ' + e.message, 'error');
    }
  });

  $('#btn-hist-copy-note')?.addEventListener('click', async () => {
    const text = $('#hist-note-text')?.innerText || '';
    try {
      await navigator.clipboard.writeText(text);
      showStatus($('#status'), 'Pesan HR tersalin ke clipboard.', 'ok');
      const b = $('#btn-hist-copy-note');
      if (b) {
        b.textContent = 'Tersalin';
        setTimeout(() => (b.textContent = 'Copy pesan'), 1500);
      }
    } catch (e) {
      showStatus($('#status'), 'Gagal copy: ' + e.message, 'error');
    }
  });

  $('#hist-note-text')?.addEventListener('input', (e) => {
    const text = e.target.innerText || '';
    if (state.activeHistoryItem) state.activeHistoryItem.recruiter_note = text;
    const countEl = $('#hist-note-chars');
    if (countEl) countEl.textContent = text.length;
    $('#hist-note-count-wrap')?.classList.toggle('over', text.length > 300);
  });

  $('#btn-clear-history').addEventListener('click', () => {
    if (!confirm('Hapus semua riwayat generate?')) return;
    chrome.storage.local.set({ history: [] }, renderHistory);
  });

  // settings tab
  updateSettingsView();

  $('#btn-clear-key')?.addEventListener('click', () => {
    const inp = $('#inp-key');
    if (inp) {
      inp.value = '';
      $('#btn-clear-key').classList.add('hidden');
      inp.focus();
    }
  });

  $('#inp-key')?.addEventListener('input', (e) => {
    $('#btn-clear-key')?.classList.toggle('hidden', !e.target.value.length);
  });

  $('#btn-toggle-key')?.addEventListener('click', () => {
    const inp = $('#inp-key');
    const isPass = inp.type === 'password';
    inp.type = isPass ? 'text' : 'password';
    $('#btn-toggle-key').textContent = isPass ? 'Tutup' : 'Lihat';
  });

  $('#btn-save-key')?.addEventListener('click', saveAndTestKey);
  $('#btn-test-key')?.addEventListener('click', testKey);
  $('#btn-refresh-models')?.addEventListener('click', refreshModelsFromApi);
  $('#btn-refresh-models-stg')?.addEventListener('click', refreshModelsFromApi);

  $('#stg-model')?.addEventListener('change', (e) => {
    const model = e.target.value;
    state.model = model;
    if ($('#sel-model')) $('#sel-model').value = model;
    updateAdvSummary();
    chrome.storage.local.set({ model });
    showStatus($('#key-status'), `Model default disimpan: ${getFriendlyModelLabel(model)}.`, 'ok');
  });

  $$('#stg-lang-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      state.lang = lang;
      $$('#stg-lang-seg button').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
      if ($('#sel-lang')) $('#sel-lang').value = lang;
      updateAdvSummary();
      chrome.storage.local.set({ lang });
      showStatus($('#key-status'), `Bahasa dokumen default: ${lang}.`, 'ok');
    });
  });

  $$('#stg-tpl-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = btn.dataset.tpl;
      state.template = tpl;
      $$('#stg-tpl-seg button').forEach((b) => b.classList.toggle('active', b.dataset.tpl === tpl));
      $$('#sp-tpl-seg button').forEach((b) => b.classList.toggle('active', b.dataset.tpl === tpl));
      applySidepanelTemplate(tpl);
      chrome.storage.local.set({ cvTemplate: tpl });
      showStatus($('#key-status'), `Template CV default: ${tpl.toUpperCase()}.`, 'ok');
    });
  });

  $('#btn-backup-data')?.addEventListener('click', () => {
    if (!state.profile) {
      alert('Belum ada data profil untuk di-backup. Isi atau impor profil terlebih dahulu di tab Profil.');
      return;
    }
    exportProfile();
  });

  $('#btn-clear-history-stg')?.addEventListener('click', async () => {
    const store = await chrome.storage.local.get(['history']);
    const count = (store.history || []).length;
    if (count === 0) {
      alert('Riwayat lamaran sudah kosong.');
      return;
    }
    if (!confirm(`Hapus ${count} riwayat lamaran yang tersimpan di browser? Profil dan API key kamu tetap aman.`)) return;
    await chrome.storage.local.set({ history: [] });
    renderHistory();
    updateSettingsView();
    showStatus($('#key-status'), `${count} riwayat lamaran berhasil dibersihkan.`, 'ok');
  });

  $('#btn-reset-all')?.addEventListener('click', async () => {
    const confirmed = confirm('PERINGATAN: Apakah kamu yakin ingin mereset SEMUA data Skillsy?\n\nSemua profil, seluruh riwayat lamaran, dan API key akan dihapus dari browser ini.');
    if (!confirmed) return;
    await chrome.storage.local.clear();
    location.reload();
  });

  // onboarding
  if (!store.apiKey) switchTab('settings');
  else if (!state.profile) switchTab('profile');
}

document.addEventListener('DOMContentLoaded', init);