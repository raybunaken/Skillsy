'use strict';

// JobFeast profile editor: halaman penuh untuk mengisi profil manual maupun
// hasil impor CV. Autosave ke chrome.storage.local (key: profile, profileRaw),
// dipakai bersama oleh sidepanel saat generate.

const $ = (s) => document.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let profileRaw = '';
let saveTimer = null;
let dirty = false;

/* ---------- baris yang bisa ditambah-hapus ---------- */

const ROW_TPL = {
  edu: (d = {}) => `
    <div class="f-row">
      <input class="f-in" data-k="institution" placeholder="Institusi" value="${esc(d.institution || '')}">
      <input class="f-in" data-k="degree" placeholder="Gelar & jurusan" value="${esc(d.degree || '')}">
      <div class="pair">
        <input class="f-in" data-k="start" placeholder="Mulai (2022)" value="${esc(d.start || '')}">
        <input class="f-in" data-k="end" placeholder="Selesai (2026)" value="${esc(d.end || '')}">
      </div>
      <input class="f-in" data-k="details" placeholder="IPK / mata kuliah relevan (opsional)" value="${esc(d.details || '')}">
      <button class="btn danger f-del">Hapus</button>
    </div>`,
  exp: (d = {}) => `
    <div class="f-row">
      <input class="f-in" data-k="company" placeholder="Perusahaan" value="${esc(d.company || '')}">
      <input class="f-in" data-k="role" placeholder="Posisi" value="${esc(d.role || '')}">
      <div class="pair">
        <input class="f-in" data-k="start" placeholder="Mulai (Jan 2025)" value="${esc(d.start || '')}">
        <input class="f-in" data-k="end" placeholder="Selesai (kosongkan jika masih jalan)" value="${esc(d.end || '')}">
      </div>
      <input class="f-in" data-k="location" placeholder="Lokasi" value="${esc(d.location || '')}">
      <textarea class="f-ta" data-k="bullets" rows="4" placeholder="Pencapaian, satu per baris (fokuskan yang ada angkanya)">${esc((d.bullets || []).join('\n'))}</textarea>
      <button class="btn danger f-del">Hapus</button>
    </div>`,
  proj: (d = {}) => `
    <div class="f-row">
      <input class="f-in" data-k="name" placeholder="Nama proyek" value="${esc(d.name || '')}">
      <input class="f-in" data-k="role" placeholder="Peran kamu" value="${esc(d.role || '')}">
      <div class="pair">
        <input class="f-in" data-k="start" placeholder="Mulai" value="${esc(d.start || '')}">
        <input class="f-in" data-k="end" placeholder="Selesai" value="${esc(d.end || '')}">
      </div>
      <input class="f-in" data-k="link" placeholder="Link (opsional)" value="${esc(d.link || '')}">
      <textarea class="f-ta" data-k="bullets" rows="3" placeholder="Pencapaian proyek, satu per baris">${esc((d.bullets || []).join('\n'))}</textarea>
      <button class="btn danger f-del">Hapus</button>
    </div>`,
  skill: (d = {}) => `
    <div class="f-row">
      <input class="f-in" data-k="category" placeholder="Kategori (cth: Technical)" value="${esc(d.category || '')}">
      <input class="f-in" data-k="items" placeholder="Item, pisahkan koma (cth: Python, SQL, Looker Studio)" value="${esc((d.items || []).join(', '))}">
      <button class="btn danger f-del">Hapus</button>
    </div>`,
};

const ROW_LIST = { edu: '#f-edu-list', exp: '#f-exp-list', proj: '#f-proj-list', skill: '#f-skill-list' };

function addRow(kind, data) {
  $(ROW_LIST[kind]).insertAdjacentHTML('beforeend', ROW_TPL[kind](data || {}));
}

function collectRows(listSel) {
  return $$(listSel + ' .f-row')
    .map((r) => {
      const o = {};
      $$('.f-in, .f-ta', r).forEach((i) => (o[i.dataset.k] = i.value.trim()));
      if (typeof o.bullets === 'string') o.bullets = o.bullets.split('\n').map((s) => s.trim()).filter(Boolean);
      return o;
    })
    .filter((o) => Object.values(o).some((v) => (Array.isArray(v) ? v.length : v)));
}

const splitComma = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function formToProfile() {
  const skills = {};
  collectRows('#f-skill-list').forEach((r) => {
    const items = splitComma(r.items);
    if (r.category && items.length) skills[r.category] = items;
  });
  const headline = $('#f-headline').value.trim();
  return {
    basics: {
      name: $('#f-name').value.trim(),
      headline_options: headline ? [headline] : [],
      email: $('#f-email').value.trim(),
      phone: $('#f-phone').value.trim(),
      location: $('#f-location').value.trim(),
      links: {
        linkedin: $('#f-linkedin').value.trim(),
        github: $('#f-github').value.trim(),
        portfolio: $('#f-portfolio').value.trim(),
      },
    },
    education: collectRows('#f-edu-list'),
    experience: collectRows('#f-exp-list'),
    projects: collectRows('#f-proj-list'),
    skills,
    certifications: splitComma($('#f-cert').value),
    languages: splitComma($('#f-lang').value),
    preferences: {
      tone: $('#f-tone').value,
      avoid: splitComma($('#f-avoid').value),
    },
  };
}

function profileToForm(p) {
  const b = (p && p.basics) || {};
  $('#f-name').value = b.name || '';
  $('#f-headline').value = (b.headline_options || [])[0] || '';
  $('#f-email').value = b.email || '';
  $('#f-phone').value = b.phone || '';
  $('#f-location').value = b.location || '';
  $('#f-linkedin').value = (b.links && b.links.linkedin) || '';
  $('#f-github').value = (b.links && b.links.github) || '';
  $('#f-portfolio').value = (b.links && b.links.portfolio) || '';

  Object.values(ROW_LIST).forEach((sel) => ($(sel).innerHTML = ''));
  (p.education || []).forEach((d) => addRow('edu', d));
  (p.experience || []).forEach((d) => addRow('exp', d));
  (p.projects || []).forEach((d) => addRow('proj', d));
  Object.entries(p.skills || {}).forEach(([category, items]) => addRow('skill', { category, items }));
  if (!(p.experience || []).length) addRow('exp');
  if (!(p.education || []).length) addRow('edu');

  $('#f-cert').value = (p.certifications || []).join(', ');
  $('#f-lang').value = (p.languages || []).join(', ');
  $('#f-tone').value = (p.preferences || {}).tone || 'professional';
  $('#f-avoid').value = ((p.preferences || {}).avoid || []).join(', ');
}

/* ---------- status & simpan ---------- */

function toast(text, isError) {
  const t = $('#p-toast');
  t.textContent = text;
  t.className = 'pstatus show' + (isError ? ' error' : '');
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => t.classList.remove('show'), isError ? 6000 : 2600);
}

function markDirty() {
  dirty = true;
  $('#p-save').textContent = 'Ada perubahan belum tersimpan';
  $('#p-save').className = 'psave';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}

async function saveNow(silent) {
  const profile = formToProfile();
  if (!profile.basics.name) {
    if (!silent) toast('Nama lengkap wajib diisi sebelum profil dipakai.', true);
    return false;
  }
  await chrome.storage.local.set({ profile, profileRaw });
  dirty = false;
  $('#p-save').textContent = 'Tersimpan ' + new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  $('#p-save').className = 'psave ok';
  if (!silent) toast('Profil tersimpan. Kembali ke sidepanel untuk generate.');
  return true;
}

/* ---------- impor dari CV ---------- */

async function importFromPdf(file) {
  toast('Membaca PDF kamu...');
  try {
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      text += tc.items.map((it) => it.str).join(' ') + '\n';
    }
    if (text.trim().length < 100) throw new Error('Teksnya kosong atau terlalu pendek.');
    toast('CV terbaca. AI sedang menstrukturkan datanya...');
    const { model } = await chrome.storage.local.get('model');
    const res = await chrome.runtime.sendMessage({
      type: 'GROQ_JSON',
      payload: {
        model: model || 'openai/gpt-oss-20b',
        temperature: 0.1,
        maxTokens: 6000,
        messages: [
          { role: 'system', content: window.JF_PROMPTS.PARSE_SYSTEM },
          { role: 'user', content: `CV text:\n"""\n${text.trim()}\n"""\nExtract to JSON now.` },
        ],
      },
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'AI tidak merespons.');
    const data = res.data;
    if (!data.basics || !data.basics.name) throw new Error('CV belum terbaca dengan benar.');
    profileRaw = text.trim();
    profileToForm(data);
    await saveNow(true);
    switchSection('basics');
    updateDots();
    toast('Impor selesai. Periksa dan lengkapi datanya, lalu tersimpan otomatis.');
  } catch (e) {
    toast('Impor gagal: ' + (e.message || e), true);
  }
}

/* ---------- navigasi section (anti doom-scrolling) ---------- */

function switchSection(id) {
  $$('.psection').forEach((s) => s.classList.toggle('active', s.id === 'sec-' + id));
  $$('#pnav button').forEach((b) => b.classList.toggle('active', b.dataset.sec === id));
  window.scrollTo({ top: 0 });
}

function sectionFilled(id) {
  switch (id) {
    case 'chat': return chatDone;
    case 'basics': return Boolean($('#f-name').value.trim());
    case 'exp': return collectRows('#f-exp-list').length > 0;
    case 'edu': return collectRows('#f-edu-list').length > 0;
    case 'proj': return collectRows('#f-proj-list').length > 0;
    case 'skill': return collectRows('#f-skill-list').length > 0;
    case 'other': return Boolean($('#f-cert').value.trim() || $('#f-lang').value.trim() || $('#f-avoid').value.trim());
    default: return false;
  }
}

function updateDots() {
  $$('#pnav button').forEach((b) => {
    b.querySelector('.dot').classList.toggle('done', sectionFilled(b.dataset.sec));
  });
  $('#hero-ava').textContent = ($('#f-name').value.trim() || '?').charAt(0).toUpperCase();
  const empties = { exp: '#exp-empty', edu: '#edu-empty', proj: '#proj-empty', skill: '#skill-empty' };
  Object.entries(empties).forEach(([k, sel]) => {
    const el = $(sel);
    if (el) el.classList.toggle('hidden', $(ROW_LIST[k]).children.length > 0);
  });
}

/* ================================================================
   MODE NGOBROL (dulu bernama Wawancara): tanya-jawab terpandu satu per satu
   dengan persona Feast supaya terasa chat dengan orang, bukan bot.
   Alurnya scripted (murah, tidak bisa nyasar); AI dipakai hanya di
   akhir untuk merapikan bullet pencapaian dengan aturan kejujuran.
   ================================================================ */

let chatDone = false;
let chatStarted = false;
const chatState = { answers: {}, exps: [], projs: [], qCount: 0, cur: null, curExp: null, curProj: null };

const CHAT_STEPS = [
  { id: 'name', q: 'Hai, aku Feast. Kita isi profil kamu sambil ngobrol santai ya. Kenalan dulu: siapa nama lengkap kamu?', ph: 'Nama lengkap...', required: true },
  { id: 'headline', q: 'Kamu biasa dikenal sebagai apa?', ph: 'cth: Data Analyst' },
  { id: 'email', q: 'Email yang mau dicantumkan di CV apa?', ph: 'nama@email.com' },
  { id: 'phone', q: 'Nomor teleponnya?', ph: '+62...' },
  { id: 'location', q: 'Domisili kamu di mana sekarang?', ph: 'cth: South Jakarta' },
  { id: 'linkedin', q: 'Punya LinkedIn? Tempel link-nya kalau ada.', ph: 'https://linkedin.com/in/...' },
  { id: 'github', q: 'GitHub atau portfolio online ada?', ph: 'https://github.com/...' },
  { id: 'edu_inst', q: 'Pendidikan terakhirmu di mana?', ph: 'cth: Universitas Muhammadiyah Surakarta' },
  { id: 'edu_deg', q: 'Ambil jurusan apa?', ph: 'cth: S1 Teknik Informatika' },
  { id: 'edu_year', q: 'Masuk dan lulus tahun berapa?', ph: 'cth: 2022 - 2026' },
  { id: 'exp_company', q: 'Oke, sekarang pengalaman kerja. Mulai dari yang paling penting ya: perusahaannya siapa?', ph: 'cth: 99 Group' },
  { id: 'exp_role', q: 'Kerja apa posisinya di sana?', ph: 'cth: Sales Operations Analyst' },
  { id: 'exp_period', q: 'Dari kapan sampai kapan?', ph: 'cth: Jan 2025 - sekarang' },
  { id: 'exp_bullets', q: 'Pencapaian kamu di sana apa saja? Tulis bebas satu per baris. Kalau ada angka, tulis: angka bikin CV kuat. Aku rapikan belakangan.', ph: 'cth: Bikin dashboard gabungin 30 spreadsheet\nKurangin error analisis 80%', multiline: true },
  { id: 'exp_next', q: 'Masih ada pengalaman lain? Tulis nama perusahaan berikutnya. Kalau tidak ada, ketik "tidak" atau klik Lewati.', ph: 'Nama perusahaan berikutnya...' },
  { id: 'proj_name', q: 'Ada proyek, riset, atau kompetisi yang kamu banggakan? Sebut namanya, atau Lewati.', ph: 'cth: Skillsy' },
  { id: 'proj_role', q: 'Peran kamu di proyek itu apa?', ph: 'cth: Founder & AI Lead' },
  { id: 'proj_desc', q: 'Ceritakan dikit: apa yang kamu kerjakan dan hasilnya gimana.', ph: 'Cerita singkat proyek...', multiline: true },
  { id: 'proj_next', q: 'Masih ada proyek lain? Tulis namanya. Kalau tidak ada, ketik "tidak" atau klik Lewati.', ph: 'Nama proyek berikutnya...' },
  { id: 'skills', q: 'Hampir kelar. Skill kamu apa saja? Banyak-banyak boleh, pisah koma.', ph: 'cth: Python, SQL, dashboard, Excel, presentasi' },
  { id: 'certs', q: 'Ada sertifikasi? Pisah koma. Ini opsional kok.', ph: 'cth: Google Data Analytics, Dicoding LLM' },
  { id: 'langs', q: 'Terakhir: bahasa yang kamu kuasai apa saja?', ph: 'cth: English (Professional), Indonesian (Native)' },
];

const POLISH_SYSTEM = `You clean up raw achievement notes for a CV.
Rules:
- Return 2-4 short bullet points, same language as the notes.
- Keep EVERY fact, tool name, and number EXACTLY as written. Never add achievements, tools, or numbers that are not in the notes.
- Tighten wording into strong CV style (verb-first, concise). Banned: "high potential", "passionate", "dynamic", exclamation marks.
Return ONLY JSON: {"bullets": ["...", "..."]}`;

function chatBubble(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  $('#chat-log').appendChild(el);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
}

/* reaksi pendek acak biar obrolan terasa manusiawi, bukan bot yang polos */
const REACTIONS = ['Sip.', 'Oke, noted.', 'Mantap.', 'Noted ya.', 'Siap.', 'Keren.', 'Oke.', 'Lanjut.'];
let lastReaction = '';
function pickReaction() {
  let r;
  do { r = REACTIONS[Math.floor(Math.random() * REACTIONS.length)]; } while (r === lastReaction && REACTIONS.length > 1);
  lastReaction = r;
  return r;
}

function askStep(idx) {
  const step = CHAT_STEPS[idx];
  if (!step) return finishChat();
  chatState.cur = step;
  chatState.qCount++;
  chatState.maxIdx = Math.max(chatState.maxIdx || 0, idx);
  const frac = chatState.maxIdx / CHAT_STEPS.length;
  $('#chat-progress').textContent =
    chatState.qCount === 1 ? 'Mulai ngobrol'
      : frac < 0.4 ? 'Masih santai'
      : frac < 0.75 ? 'Lumayan jalan'
      : 'Dikit lagi';
  chatBubble('q', (chatState.qCount > 1 ? pickReaction() + ' ' : '') + step.q);
  const input = $('#chat-input');
  input.value = '';
  input.placeholder = step.ph || 'Ketik jawabanmu...';
  input.rows = step.multiline ? 3 : 1;
  input.dataset.multiline = step.multiline ? '1' : '';
  $('#chat-skip').classList.toggle('hidden', Boolean(step.required));
  input.focus();
}

/* Jawaban negatif sehari-hari ("tidak", "engga ada", "udah", "belum kuliah")
   dianggap Lewati. Tanpa ini user yang jawab "engga ada" di pertanyaan
   "pengalaman lain?" bikin state machine mengira itu nama perusahaan baru. */
const NEG_HEAD = '(ngg?ak|ngga|engga|enggak|gak|ga|tidak|no|nope|none|nothing|skip|lewat|udah|sudah|cukup|selesai|belum|kosong)';
const NEG_TAIL = '(?:\\s+(?:ada|lagi|usah|cukup|semua|apapun|apa|pun|aja|saja|deh|kok|dulu|pernah|punya|kerja|pengalaman|proyek|pendidikan|kuliah|sekolah|ingat|tau|tahu)){0,3}[\\s,.!]*$';
const NEG_ANSWER_RE = new RegExp('^\\s*' + NEG_HEAD + '\\b' + NEG_TAIL, 'i');

function chatNegative(v) {
  if (!v || v.length > 30) return false;
  if (/^\s*(n\/a|[-.x]+)\s*$/i.test(v)) return true;
  return NEG_ANSWER_RE.test(v);
}

function chatSubmit(skipClicked) {
  const step = chatState.cur;
  if (!step) return;
  const input = $('#chat-input');
  let value = skipClicked ? '' : input.value.trim();
  let skipped = skipClicked;

  if (!skipped && !value) {
    input.focus();
    return;
  }
  if (!skipped && !step.required && chatNegative(value)) {
    chatBubble('a', value);
    chatBubble('sys', 'Oke, aku anggap tidak ada. Lanjut ya.');
    skipped = true;
    value = '';
  }
  if (!skipped) chatBubble('a', value);
  else if (step.required) return;

  const a = chatState.answers;
  const pushExp = () => {
    if (chatState.curExp && chatState.curExp.company) chatState.exps.push(chatState.curExp);
    chatState.curExp = null;
  };
  const pushProj = () => {
    if (chatState.curProj && chatState.curProj.name) chatState.projs.push(chatState.curProj);
    chatState.curProj = null;
  };
  const idx = CHAT_STEPS.indexOf(step);

  switch (step.id) {
    case 'name': a.name = value; return askStep(idx + 1);
    case 'headline': a.headline = value; return askStep(idx + 1);
    case 'email': a.email = value; return askStep(idx + 1);
    case 'phone': a.phone = value; return askStep(idx + 1);
    case 'location': a.location = value; return askStep(idx + 1);
    case 'linkedin': a.linkedin = value; return askStep(idx + 1);
    case 'github': a.github = value; return askStep(idx + 1);
    case 'edu_inst':
      if (skipped) return askStep(idx + 3); // lompat blok pendidikan (langsung ke exp_company)
      a.edu_inst = value;
      return askStep(idx + 1);
    case 'edu_deg': a.edu_deg = value; return askStep(idx + 1);
    case 'edu_year': a.edu_year = value; return askStep(idx + 1);
    case 'exp_company':
      if (skipped) { pushExp(); return askStep(idx + 5); } // lompat blok pengalaman (ke proj_name)
      chatState.curExp = { company: value };
      return askStep(idx + 1);
    case 'exp_role':
      if (!chatState.curExp) chatState.curExp = {};
      chatState.curExp.role = value;
      return askStep(idx + 1);
    case 'exp_period':
      if (!chatState.curExp) chatState.curExp = {};
      chatState.curExp.period = value;
      return askStep(idx + 1);
    case 'exp_bullets':
      if (!chatState.curExp) chatState.curExp = {};
      chatState.curExp.bullets = value.split('\n').map((s) => s.trim()).filter(Boolean);
      return askStep(idx + 1);
    case 'exp_next':
      pushExp();
      if (skipped) return askStep(idx + 1);
      chatState.curExp = { company: value };
      return askStep(CHAT_STEPS.findIndex((s) => s.id === 'exp_role'));
    case 'proj_name':
      if (skipped) { pushProj(); return askStep(idx + 4); }
      chatState.curProj = { name: value };
      return askStep(idx + 1);
    case 'proj_role':
      if (!chatState.curProj) chatState.curProj = {};
      chatState.curProj.role = value;
      return askStep(idx + 1);
    case 'proj_desc':
      if (!chatState.curProj) chatState.curProj = {};
      chatState.curProj.bullets = value.split('\n').map((s) => s.trim()).filter(Boolean);
      return askStep(idx + 1);
    case 'proj_next':
      pushProj();
      if (skipped) return askStep(idx + 1);
      chatState.curProj = { name: value };
      return askStep(CHAT_STEPS.findIndex((s) => s.id === 'proj_role'));
    case 'skills': a.skills = value; return askStep(idx + 1);
    case 'certs': a.certs = value; return askStep(idx + 1);
    case 'langs': a.langs = value; return askStep(idx + 1);
    default: return askStep(idx + 1);
  }
}

function splitPeriod(p) {
  const parts = String(p || '').split(/\s*[-\u2013]\s*/).filter(Boolean);
  return { start: parts[0] || '', end: parts[1] || '' };
}

async function polishBullets(bullets, context) {
  if (!bullets || !bullets.length) return bullets;
  try {
    const { model } = await chrome.storage.local.get('model');
    const res = await chrome.runtime.sendMessage({
      type: 'GROQ_JSON',
      payload: {
        model: model || 'openai/gpt-oss-20b',
        temperature: 0.3,
        maxTokens: 800,
        messages: [
          { role: 'system', content: POLISH_SYSTEM },
          { role: 'user', content: `CONTEXT: ${context}\nRAW NOTES:\n"""\n${bullets.join('\n')}\n"""` },
        ],
      },
    });
    if (res && res.ok && res.data && Array.isArray(res.data.bullets) && res.data.bullets.length) {
      return res.data.bullets.map(String);
    }
  } catch (_) { /* gagal AI: pakai bullet mentah apa adanya */ }
  return bullets;
}

async function finishChat() {
  $('#chat-skip').classList.add('hidden');
  $('#chat-send').disabled = true;
  chatBubble('sys', 'Bentar ya, aku susun profil dan rapikan pencapaianmu...');
  const a = chatState.answers;
  const eduPeriod = splitPeriod(a.edu_year);
  const profile = {
    basics: {
      name: a.name || '',
      headline_options: a.headline ? [a.headline] : [],
      email: a.email || '',
      phone: a.phone || '',
      location: a.location || '',
      links: { linkedin: a.linkedin || '', github: a.github || '', portfolio: '' },
    },
    education: a.edu_inst ? [{ institution: a.edu_inst, degree: a.edu_deg || '', start: eduPeriod.start, end: eduPeriod.end, details: '' }] : [],
    experience: [],
    projects: [],
    skills: a.skills ? { Skills: splitComma(a.skills) } : {},
    certifications: a.certs ? splitComma(a.certs) : [],
    languages: a.langs ? splitComma(a.langs) : [],
    preferences: { tone: 'professional', avoid: [] },
  };
  for (const e of chatState.exps) {
    const p = splitPeriod(e.period);
    profile.experience.push({
      company: e.company, role: e.role || '', start: p.start, end: p.end, location: '',
      bullets: await polishBullets(e.bullets, `${e.role || ''} at ${e.company}`),
    });
  }
  for (const pr of chatState.projs) {
    profile.projects.push({ name: pr.name, role: pr.role || '', start: '', end: '', link: '', bullets: await polishBullets(pr.bullets, pr.name) });
  }
  profileToForm(profile);
  await saveNow(true);
  chatDone = true;
  updateDots();
  chatBubble('sys', 'Kelar! Profilmu sudah tersimpan. Cek dan sunting tiap bagian lewat menu di kiri ya.');
  $('#chat-send').disabled = false;
  toast('Profil dari obrolan tersimpan.');
  switchSection('basics');
}

function resetChat() {
  $('#chat-log').innerHTML = '';
  Object.assign(chatState, { answers: {}, exps: [], projs: [], qCount: 0, maxIdx: 0, cur: null, curExp: null, curProj: null });
  askStep(0);
}

function startChatIfNeeded() {
  if (chatStarted) return;
  chatStarted = true;
  askStep(0);
}



async function init() {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

  const store = await chrome.storage.local.get(['profile', 'profileRaw']);
  profileRaw = store.profileRaw || '';
  profileToForm(store.profile || {});
  const hasProfile = Boolean(store.profile && store.profile.basics && store.profile.basics.name);
  if (hasProfile) {
    $('#p-title').textContent = 'Profil - ' + store.profile.basics.name;
    $('#p-save').textContent = 'Tersimpan';
    $('#p-save').className = 'psave ok';
  }
  switchSection(hasProfile ? 'basics' : 'start');
  updateDots();

  $$('#pnav button').forEach((b) => b.addEventListener('click', () => switchSection(b.dataset.sec)));
  $('#p-import-2').addEventListener('click', () => $('#p-import-file').click());
  $('#p-start-manual').addEventListener('click', () => switchSection('basics'));

  document.addEventListener('input', (e) => {
    if (e.target.matches('.f-in, .f-ta, #f-cert, #f-lang, #f-avoid, .pfield input')) {
      if (e.target.id === 'f-name') {
        $('#p-title').textContent = 'Profil' + (e.target.value ? ' - ' + e.target.value : ' kamu');
      }
      markDirty();
      updateDots();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-tone') markDirty();
  });

  $$('.f-add').forEach((btn) =>
    btn.addEventListener('click', () => {
      addRow(btn.dataset.list);
      updateDots();
    })
  );
  Object.values(ROW_LIST).forEach((sel) =>
    $(sel).addEventListener('click', (e) => {
      const del = e.target.closest('.f-del');
      if (del) {
        del.closest('.f-row').remove();
        markDirty();
        updateDots();
      }
    })
  );

  $('#p-save-btn').addEventListener('click', () => saveNow(false));
  $('#p-import').addEventListener('click', () => $('#p-import-file').click());
  $('#p-import-file').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importFromPdf(e.target.files[0]);
    e.target.value = '';
  });

  // mode wawancara
  $('#p-start-chat').addEventListener('click', () => {
    switchSection('chat');
    startChatIfNeeded();
  });
  const origSwitch = switchSection;
  switchSection = function (id) {
    origSwitch(id);
    if (id === 'chat') startChatIfNeeded();
  };
  $('#chat-send').addEventListener('click', () => chatSubmit(false));
  $('#chat-skip').addEventListener('click', () => chatSubmit(true));
  $('#chat-reset').addEventListener('click', resetChat);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !$('#chat-input').dataset.multiline) {
      e.preventDefault();
      chatSubmit(false);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
