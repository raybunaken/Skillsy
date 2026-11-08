'use strict';

// JobFeast viewer + editor: hasil generate terbuka penuh seperti PDF reader,
// bisa disunting langsung seperti Word (contenteditable), dan potongan teks
// yang diblok bisa direvisi AI lewat bubble instruksi yang muncul di tempat.
// Data: chrome.storage.local.lastGen (diperbarui otomatis saat suntingan).

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const params = new URLSearchParams(location.search);
let doc = params.get('doc') === 'cl' ? 'cl' : 'cv';
let lastGen = null;
let currentModel = 'openai/gpt-oss-20b';
let currentTemplate = 'modern';
let currentZoom = '100';
const undoStacks = { cv: [], cl: [] };

const REVISE_SYSTEM = `You revise ONE short selected fragment of a CV or cover letter.
Rules:
- Return ONLY the revised fragment text, same language as the fragment.
- Keep every fact, name, company, number, and metric EXACTLY as in the original fragment. Never add new facts, skills, or numbers.
- Follow the user instruction (tone, length, formality). Default when no instruction: make it clearer, tighter, and more professional.
- The instruction may be a vague criticism ("not good", "kurang oke", "ganti dong", "improve this", "bad"). Treat ANY such request as a demand for a SUBSTANTIAL rewrite. Never return the original or near-identical text when the user asked for any change.
- If the instruction asks for conciseness or shortening, shorten SUBSTANTIALLY (aim for roughly 20-40% fewer words).
- If the user asks for a specific number of points or bullets (e.g. "buat jadi 2 point", "3 bullets", "ringkas jadi 2"), return EXACTLY that number of bullet items, each starting on a new line with "- " and without empty lines.
- If revising bullet points, ensure each point is a complete, strong achievement sentence.
- Banned words: "high potential", "passionate", "dynamic", "fast-paced", "proven track record", exclamation marks.
Return ONLY JSON: {"revised": "..."}`;


function unwrapDoc(html) {
  if (!html) return '';
  const trimmed = html.trim();
  const match = trimmed.match(/^<div class="tcv-(?:cv|cl)[^"]*">([\s\S]*)<\/div>$/i);
  return match ? match[1] : trimmed;
}

function render() {
  $$('#v-seg button').forEach((b) => b.classList.toggle('active', b.dataset.doc === doc));
  const page = $('#v-page');
  page.innerHTML = '';
  $('#v-undo').classList.toggle('hidden', (undoStacks[doc] || []).length === 0);
  if (!lastGen) {
    $('#v-empty').classList.remove('hidden');
    return;
  }
  $('#v-empty').classList.add('hidden');
  const el = document.createElement('div');
  const tplClass = 'tpl-' + currentTemplate;
  if (doc === 'cv') {
    el.className = 'tcv-cv ' + tplClass;
    el.innerHTML = unwrapDoc(lastGen.cvHtml || '');
  } else {
    el.className = 'tcv-cl ' + tplClass;
    el.innerHTML = unwrapDoc(lastGen.clHtml || '');
  }
  $$('#v-tpl-seg button').forEach((b) => b.classList.toggle('active', b.dataset.tpl === currentTemplate));
  page.appendChild(el);
  const who = (lastGen.basics && lastGen.basics.name) || '';
  const comp = (lastGen.job && lastGen.job.company) || '';
  $('#v-title').textContent = `${doc === 'cv' ? 'CV' : 'Cover Letter'} - ${who}${comp ? ' - ' + comp : ''}`;
  document.title = $('#v-title').textContent;
  ensureOnePageViewer();
}

async function load() {
  const store = await chrome.storage.local.get(['lastGen', 'model', 'cvTemplate']);
  if (store.cvTemplate) currentTemplate = store.cvTemplate;
  lastGen = store.lastGen || null;
  if (store.model) currentModel = store.model;
  render();
  if (currentZoom !== '100') applyZoom(currentZoom);
}

$$('#v-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    doc = b.dataset.doc;
    render();
    if (currentZoom !== '100') applyZoom(currentZoom);
  })
);
function applyTemplate(tpl) {
  currentTemplate = tpl;
  $$('#v-tpl-seg button').forEach((b) => b.classList.toggle('active', b.dataset.tpl === tpl));
  const el = PAGE.firstElementChild;
  if (el) {
    el.classList.remove('tpl-modern', 'tpl-classic', 'tpl-compact');
    el.classList.add('tpl-' + tpl);
    ensureOnePageViewer();
    saveViewerEdits();
  }
  chrome.storage.local.set({ cvTemplate: tpl });
}

function applyZoom(level) {
  currentZoom = level;
  $$('#v-zoom-seg button').forEach((b) => b.classList.toggle('active', b.dataset.zoom === level));
  const page = $('#v-page');
  if (!page) return;

  let scale = 1;
  if (level === '85') {
    scale = 0.85;
  } else if (level === 'fit') {
    const dock = $('.vdock');
    const availableWidth = (dock ? dock.clientWidth : window.innerWidth) - 48;
    scale = Math.min(1.2, Math.max(0.55, availableWidth / 794));
  } else {
    scale = 1;
  }

  if (scale === 1) {
    page.style.transform = '';
    page.style.marginBottom = '';
  } else {
    page.style.transform = 'scale(' + scale.toFixed(3) + ')';
    page.style.transformOrigin = 'top center';
    const baseHeight = page.firstElementChild ? page.firstElementChild.offsetHeight : 1123;
    const diff = (baseHeight * scale) - baseHeight;
    page.style.marginBottom = diff.toFixed(0) + 'px';
  }
}

$$('#v-tpl-seg button').forEach((b) =>
  b.addEventListener('click', () => applyTemplate(b.dataset.tpl))
);

$$('#v-zoom-seg button').forEach((b) =>
  b.addEventListener('click', () => applyZoom(b.dataset.zoom))
);

window.addEventListener('resize', () => {
  if (currentZoom === 'fit') applyZoom('fit');
});


/* ================================================================
   MODE SUNTING ala Word + autosave
   ================================================================ */

const PAGE = $('#v-page');
PAGE.setAttribute('contenteditable', 'true');
PAGE.setAttribute('spellcheck', 'false');

/* Jaminan 1 halaman dijalankan juga di viewer: setiap suntingan manual dan
   revisi AI dicek ulang. Kompresi bertahap: normal -> compact -> compact2
   -> penurunan font bertahap sampai muat (batas 8px). */
function ensureOnePageViewer() {
  const el = PAGE.firstElementChild;
  if (!el) return true;
  el.classList.remove('compact', 'compact2');
  el.style.fontSize = '';
  const fits = () => el.scrollHeight <= 1135;
  const updateIndicator = () => updateFitIndicator(el);
  if (fits()) { updateIndicator(); return true; }
  el.classList.add('compact');
  if (fits()) { updateIndicator(); return true; }
  el.classList.add('compact2');
  if (fits()) { updateIndicator(); return true; }
  const base = parseFloat(getComputedStyle(el).fontSize) || 11;
  for (let f = base - 0.3; f >= 8; f -= 0.3) {
    el.style.fontSize = f.toFixed(1) + 'px';
    if (fits()) { updateIndicator(); return true; }
  }
  updateIndicator();
  return fits();
}

function updateFitIndicator(el) {
  const tag = $('#v-fit');
  if (!tag) return;
  const over = el && el.scrollHeight > 1135;
  tag.textContent = over ? '2 halaman' : '1 halaman';
  tag.className = 'vfit' + (over ? ' over' : '');
}

// salinan bersih HTML tanpa highlight diff (untuk simpanan dan undo)
function cleanedInnerHtml() {
  const target = PAGE.firstElementChild || PAGE;
  const clone = target.cloneNode(true);
  clone.querySelectorAll('span.jfdiff').forEach((sp) => {
    const parent = sp.parentNode;
    parent.replaceChild(document.createTextNode(sp.textContent), sp);
    parent.normalize();
  });
  return clone.innerHTML;
}

let autosaveTimer = null;
PAGE.addEventListener('input', () => {
  // user mengetik manual di dokumen: tutup bubble dan lepas seleksi tersimpan
  hideBubbleAndPending();
  clearDiffHighlights();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    ensureOnePageViewer();
    saveViewerEdits();
  }, 800);
});

async function saveViewerEdits() {
  if (!lastGen) return;
  const html = cleanedInnerHtml();
  if (doc === 'cv') lastGen.cvHtml = html;
  else lastGen.clHtml = html;
  await chrome.storage.local.set({ lastGen });
}

function pushUndo() {
  if (!undoStacks[doc]) undoStacks[doc] = [];
  undoStacks[doc].push(cleanedInnerHtml());
  if (undoStacks[doc].length > 20) undoStacks[doc].shift();
  $('#v-undo').classList.remove('hidden');
}

function undoLast() {
  if (!undoStacks[doc]) return;
  const prev = undoStacks[doc].pop();
  if (prev === undefined) return;
  const el = PAGE.firstElementChild;
  if (el) el.innerHTML = prev;
  else PAGE.innerHTML = prev;
  ensureOnePageViewer();
  saveViewerEdits();
  $('#v-undo').classList.toggle('hidden', undoStacks[doc].length === 0);
}

/* ================================================================
   BUBBLE REVISI AI pada teks yang diblok
   ================================================================ */

const bubble = document.createElement('div');
bubble.id = 'sel-bubble';
bubble.innerHTML = `
  <div class="b-input-wrap">
    <input id="b-instr" placeholder="Instruksi revisi (opsional)..." autocomplete="off" spellcheck="false">
    <button id="b-go" class="b-submit-btn">Perbaiki</button>
  </div>
  <div class="b-chips">
    <button type="button" data-t="Make it more concise and to the point">Ringkas</button>
    <button type="button" data-t="Make it more formal and professional">Formal</button>
    <button type="button" data-t="Fix grammar and wording without changing meaning">Bahasa</button>
    <button type="button" data-t="Highlight key numbers and metrics">Fokus Angka</button>
  </div>
  <div id="b-note" class="b-note hidden"><span id="b-note-text"></span><div class="b-note-actions"><button id="b-compare" class="b-compare-btn hidden">Bandingkan</button><button id="b-accept" class="b-accept-btn hidden">Terima</button></div></div>
  <div id="b-compare-list" class="b-compare hidden"></div>
`;
document.body.appendChild(bubble);

const escHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hideBubble = () => bubble.classList.remove('show');

/* State seleksi TERSIMPAN: begitu user memblok teks, range dan teksnya
   dikunci. Fokus pindah ke kotak instruksi (seleksi visual kolaps) tidak
   menghapusnya, dan AI tetap merevisi fragmen yang benar. Tanda biru lewat
   CSS Custom Highlight menempel selama bubble aktif. */
let pendingRange = null;
let pendingText = '';
let resultStickyUntil = 0;

function registerSelHighlight() {
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights && typeof window.Highlight === 'function') {
      CSS.highlights.set('jobfeast-sel', new Highlight(pendingRange));
    }
  } catch (_) { /* browser tanpa Custom Highlight: lewati, hanya tanpa tanda */ }
}

function clearSelHighlight() {
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('jobfeast-sel');
  } catch (_) {}
}

function hideBubbleAndPending() {
  hideBubble();
  pendingRange = null;
  pendingText = '';
  resultStickyUntil = 0;
  clearSelHighlight();
}

function showBubbleAtSelection() {
  const sel = window.getSelection();
  let rect = null;
  if (sel && !sel.isCollapsed && PAGE.contains(sel.anchorNode)) {
    rect = sel.getRangeAt(0).getBoundingClientRect();
  } else if (pendingRange) {
    try { rect = pendingRange.getBoundingClientRect(); } catch (_) { rect = null; }
  }
  if (!rect) {
    hideBubble();
    return;
  }
  bubble.classList.add('show');
  const bw = 370;
  let left = rect.left + window.scrollX + rect.width / 2 - bw / 2;
  left = Math.max(16, Math.min(left, document.documentElement.scrollWidth - bw - 16));

  const spaceBelow = window.innerHeight - rect.bottom;
  const bubbleHeight = 115;
  let top;
  if (spaceBelow < bubbleHeight + 20 && rect.top > bubbleHeight + 20) {
    top = rect.top + window.scrollY - bubbleHeight - 10;
  } else {
    top = rect.bottom + window.scrollY + 10;
  }
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
}

document.addEventListener('selectionchange', () => {
  // beri jeda supaya bubble tidak berkedip saat seleksi sedang dibuat
  setTimeout(() => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && PAGE.contains(sel.anchorNode)) {
      const text = String(sel).trim();
      if (text.length >= 3) {
        // seleksi baru selalu menang, termasuk saat ringkasan hasil masih tampil
        resultStickyUntil = 0;
        pendingRange = sel.getRangeAt(0).cloneRange();
        pendingText = text;
        registerSelHighlight();
        $('#b-note').classList.add('hidden');
        showBubbleAtSelection();
        return;
      }
    }
    // seleksi kolaps (mis. fokus pindah ke kotak instruksi): JANGAN sembunyikan,
    // seleksi tersimpan masih berlaku. Sembunyikan hanya dari klik luar/Escape/
    // mengetik di dokumen.
  }, 200);
});

document.addEventListener('mousedown', (e) => {
  if (bubble.contains(e.target) || e.target.closest('#sel-bubble')) return;
  if (Date.now() < resultStickyUntil) return;
  hideBubbleAndPending();
});

$$('.b-chips button').forEach((c) =>
  c.addEventListener('click', () => {
    $('#b-instr').value = c.dataset.t;
    $('#b-instr').focus();
  })
);

$('#b-instr').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyRevision($('#b-instr').value.trim());
  }
});

$('#b-go').addEventListener('click', () => applyRevision($('#b-instr').value.trim()));

function bnote(text, isError) {
  $('#b-note-text').textContent = text;
  const n = $('#b-note');
  n.className = 'b-note' + (isError ? ' error' : '');
  n.classList.remove('hidden');
  $('#b-compare').classList.add('hidden');
  $('#b-accept').classList.add('hidden');
  $('#b-compare-list').classList.add('hidden');
}

/* ---------- diff tingkat kalimat: ringkasan yang berarti untuk manusia ---------- */

function splitSentences(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  let parts;
  try {
    parts = t.split(/(?<=[.!?])\s+/);
  } catch (_) {
    parts = t.split('. ');
  }
  return parts.map((x) => x.trim()).filter((x) => x.length);
}

// Penjajaran sederhana: kalimat sama dilewati, kalimat beda dipasangkan
// lama->baru supaya mudah dibaca berdampingan. Untuk fragmen 1-5 kalimat
// (kasus revisi) ini jauh lebih terbaca daripada alignment DP penuh.
function sentenceDiff(orig, rev) {
  const a = splitSentences(orig);
  const b = splitSentences(rev);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const old = a[i] || null;
    const neu = b[j] || null;
    if (old && neu && old === neu) {
      i++; j++;
      continue;
    }
    pairs.push({ old, neu });
    if (old) i++;
    if (neu) j++;
  }
  return pairs;
}

function showCompareList(pairs) {
  const changed = pairs.filter((p) => p.old !== p.neu).slice(0, 8);
  const list = $('#b-compare-list');
  list.innerHTML = changed
    .map(
      (p) =>
        '<div class="s-pair">' +
        '<div class="s-lab">Sebelum</div>' +
        '<div class="s-old">' + escHtml(p.old || '(kalimat dihapus)') + '</div>' +
        '<div class="s-lab new">Sesudah</div>' +
        '<div class="s-new">' + escHtml(p.neu || '(kalimat dihapus)') + '</div>' +
        '</div>'
    )
    .join('');
  list.classList.toggle('hidden');
}

$('#b-compare').addEventListener('click', () => showCompareList(window.__jfLastPairs || []));

const numberTokens = (s) => (String(s).match(/~?\d[\d.,]*\s*(?:%|x)?/gi) || []).map((t) => t.replace(/\s+/g, '').toLowerCase());

/* ---------- diff tingkat kata: supaya user MELIHAT apa yang diubah AI ---------- */

function diffWords(orig, rev) {
  const split = (s) => String(s).split(/(\s+)/).filter((t) => t.length);
  const a = split(orig);
  const b = split(rev);
  const n = a.length;
  const m = b.length;
  if (n * m > 250000) {
    return { tokens: [{ t: rev, changed: true }], added: b.filter((t) => t.trim()).length, removed: a.filter((t) => t.trim()).length };
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const tokens = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      tokens.push({ t: b[j], changed: false });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (a[i].trim()) removed++;
      i++;
    } else {
      if (b[j].trim()) added++;
      tokens.push({ t: b[j], changed: true });
      j++;
    }
  }
  while (i < n) { if (a[i].trim()) removed++; i++; }
  while (j < m) { if (b[j].trim()) added++; tokens.push({ t: b[j], changed: true }); j++; }
  return { tokens, added, removed };
}

function extractBulletItems(text) {
  const rawLines = String(text || '').split(/\r?\n+/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const line of rawLines) {
    const cleaned = line.replace(/^[\s\-\u2022*\d.)]+\s*/, '').trim();
    if (cleaned) items.push(cleaned);
  }
  return items.length ? items : (text && text.trim() ? [text.trim()] : []);
}

function renderDiffFragment(d) {
  // gabungkan token berurutan berstatus sama; spasi mengikuti status run sebelumnya
  const runs = [];
  for (const tok of d.tokens) {
    const ch = tok.t.trim() ? tok.changed : runs.length ? runs[runs.length - 1].changed : false;
    if (runs.length && runs[runs.length - 1].changed === ch) runs[runs.length - 1].t += tok.t;
    else runs.push({ t: tok.t, changed: ch });
  }
  const frag = document.createDocumentFragment();
  for (const run of runs) {
    if (!run.t) continue;
    if (run.changed) {
      const sp = document.createElement('span');
      sp.className = 'jfdiff';
      sp.textContent = run.t;
      frag.appendChild(sp);
    } else {
      frag.appendChild(document.createTextNode(run.t));
    }
  }
  return frag;
}

// highlight diff bersifat sementara: dibersihkan sebelum simpan / PDF / saat user mengetik
function clearDiffHighlights() {
  PAGE.querySelectorAll('span.jfdiff').forEach((sp) => {
    const parent = sp.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(sp.textContent), sp);
    parent.normalize();
  });
}

async function applyRevision(instruction) {
  if (!pendingRange || !pendingText) {
    bnote('Blok dulu teks yang mau diperbaiki.', true);
    bubble.classList.add('show');
    return;
  }
  const original = pendingText;
  const range = pendingRange;
  if (!range.startContainer || !range.startContainer.isConnected) {
    bnote('Seleksi sudah tidak berlaku karena dokumen berubah. Blok ulang teksnya.', true);
    bubble.classList.add('show');
    hideBubbleAndPending();
    return;
  }
  const go = $('#b-go');
  go.disabled = true;
  go.textContent = 'AI bekerja...';
  try {
    const contextEl = PAGE.cloneNode(true);
    const full = (contextEl.innerText || '').slice(0, 1200);
    const askRevision = (extraPrefix) =>
      chrome.runtime.sendMessage({
        type: 'GROQ_JSON',
        payload: {
          model: currentModel,
          temperature: 0.4,
          maxTokens: 1200,
          messages: [
            { role: 'system', content: REVISE_SYSTEM },
            {
              role: 'user',
              content:
                (extraPrefix || '') +
                `DOCUMENT TYPE: ${doc === 'cv' ? 'CV' : 'cover letter'}\n` +
                `INSTRUCTION: ${instruction || 'improve clarity, tightness, and professionalism'}\n` +
                `DOCUMENT CONTEXT (do not revise this): ${full.slice(0, 600)}\n` +
                `FRAGMENT TO REVISE:\n"""\n${original}\n"""`,
            },
          ],
        },
      });

    const extract = (res) => {
      if (!res || !res.ok) throw new Error((res && res.error) || 'AI tidak merespons.');
      return String((res.data && res.data.revised) || '').trim();
    };

    let revised = extract(await askRevision());
    let d = diffWords(original, revised);

    // AI membandel: membalas teks yang sama padahal user minta perubahan.
    // Coba sekali lagi dengan penekanan eksplisit sebelum menyerah.
    let retried = false;
    if (!d.added && !d.removed && instruction) {
      go.textContent = 'AI membandel, memaksa sekali lagi...';
      retried = true;
      revised = extract(
        await askRevision(
          'IMPORTANT: your previous answer was identical to the original fragment and the user explicitly rejected it. ' +
            'Rewrite the fragment SUBSTANTIALLY, with different sentence structure. Instruction: '
        )
      );
      d = diffWords(original, revised);
    }

    if (!d.added && !d.removed) {
      resultStickyUntil = Date.now() + 8000;
      bnote(
        retried
          ? 'AI dua kali mengembalikan teks yang sama. Coba instruksi lebih spesifik, misalnya apa yang kurang oke dan seperti apa yang kamu mau.'
          : 'AI menilai teks ini sudah sesuai instruksi dan tidak mengubah apa pun.',
        retried
      );
      bubble.classList.add('show');
      return;
    }

    pushUndo();

    // Deteksi cerdas: apakah seleksi berada di dalam daftar bullet (<ul>/<ol>)
    const ancestor = range.commonAncestorContainer;
    const ancestorEl = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;
    const ul = ancestorEl ? ancestorEl.closest('ul, ol') : null;

    let touchedLis = [];
    if (ul) {
      const allLis = [...ul.querySelectorAll('li')];
      touchedLis = allLis.filter((li) => {
        try {
          return range.intersectsNode(li);
        } catch (_) {
          return false;
        }
      });
    }

    const bulletItems = extractBulletItems(revised);
    const isMultiBulletEdit = touchedLis.length > 1 || (touchedLis.length === 1 && bulletItems.length > 1);

    if (ul && touchedLis.length > 0 && isMultiBulletEdit) {
      // Ganti seluruh baris <li> lama dengan baris <li> baru yang rapi
      const firstLi = touchedLis[0];
      const parentUl = firstLi.parentElement;

      const newLis = bulletItems.map((itemText) => {
        const li = document.createElement('li');
        const itemDiff = diffWords(original, itemText);
        li.appendChild(renderDiffFragment(itemDiff));
        return li;
      });

      newLis.forEach((newLi) => {
        parentUl.insertBefore(newLi, firstLi);
      });

      // Hapus seluruh <li> lama yang telah digantikan
      touchedLis.forEach((oldLi) => oldLi.remove());
    } else {
      // Penggantian teks inline biasa (paragraf / kalimat tunggal)
      range.deleteContents();
      range.insertNode(renderDiffFragment(d));
    }

    // Bersihkan residu elemen <li> kosong di seluruh dokumen agar tidak ada bullet dot hantu
    PAGE.querySelectorAll('li').forEach((li) => {
      if (!li.textContent.trim()) li.remove();
    });

    window.getSelection().removeAllRanges();
    clearSelHighlight();
    pendingRange = null;
    pendingText = '';
    ensureOnePageViewer();
    saveViewerEdits();
    bubble.classList.add('show');
    resultStickyUntil = Date.now() + 8000;

    // ringkasan per KALIMAT (yang berarti untuk manusia), detail via Bandingkan
    const pairs = sentenceDiff(original, revised);
    const changedSentences = pairs.filter((p) => p.old !== p.neu).length;
    window.__jfLastPairs = pairs;

    const origNums = new Set(numberTokens(original));
    const suspicious = numberTokens(revised).filter((n) => !origNums.has(n));
    let ringkasan = `${changedSentences} kalimat berubah (${d.added + d.removed} kata).`;
    bnote(ringkasan, false);
    $('#b-accept').classList.remove('hidden');
    if (changedSentences > 0) {
      $('#b-compare').classList.remove('hidden');
      $('#b-compare').textContent = 'Bandingkan';
      $('#b-compare-list').classList.add('hidden');
    }
    if (suspicious.length) {
      bnote(ringkasan + ' Perhatian: ada angka baru (' + suspicious.join(', ') + ').', true);
      $('#b-accept').classList.remove('hidden');
      $('#b-compare').classList.remove('hidden');
    }
  } catch (e) {
    bnote('Gagal: ' + (e.message || e), true);
  } finally {
    go.disabled = false;
    go.textContent = 'Perbaiki';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideBubbleAndPending();
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    e.preventDefault();
    undoLast();
  }
});

$('#v-undo').addEventListener('click', undoLast);

/* ================================================================
   COPY & DOWNLOAD
   ================================================================ */

$('#v-copy').addEventListener('click', async () => {
  if (!lastGen) return;
  const btn = $('#v-copy');
  try {
    const text = PAGE.innerText;
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Tersalin';
    setTimeout(() => (btn.textContent = 'Copy teks'), 1500);
  } catch (_) {
    btn.textContent = 'Gagal';
    setTimeout(() => (btn.textContent = 'Copy teks'), 1500);
  }
});

const sanitizeFile = (s) =>
  String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);

$('#v-dl').addEventListener('click', async () => {
  if (!lastGen) return;
  const btn = $('#v-dl');
  btn.disabled = true;
  btn.textContent = 'Menyusun PDF...';
  try {
    const el = PAGE.firstElementChild;
    if (!el) throw new Error('tidak ada dokumen');
    // jaminan 1 halaman + highlight diff tidak boleh ikut ke PDF
    const prevTransform = PAGE.style.transform;
    const prevMarginBottom = PAGE.style.marginBottom;
    PAGE.style.transform = 'none';
    PAGE.style.marginBottom = '';
    clearDiffHighlights();
    if (!ensureOnePageViewer()) {
      throw new Error('Dokumen masih melebihi 1 halaman walaupun sudah dikompresi otomatis. Persingkat isinya dulu (hapus bullet atau bagian yang kurang relevan).');
    }
    const opt = {
      margin: 0,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: 794 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    };
    let url;
    try {
      url = URL.createObjectURL(await html2pdf().set(opt).from(el).outputPdf('blob'));
    } catch (_) {
      url = await html2pdf().set(opt).from(el).outputPdf('datauristring');
    }
    const label = doc === 'cv' ? 'CV' : 'Cover Letter';
    const filename = `Skillsy/${label} - ${sanitizeFile(lastGen.basics && lastGen.basics.name)} - ${sanitizeFile(lastGen.job && lastGen.job.company)}.pdf`;
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    if (url && url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 60000);
    btn.textContent = 'Tersimpan';
  } catch (e) {
    alert('Gagal membuat PDF: ' + (e && e.message ? e.message : e));
    btn.textContent = 'Download PDF';
  } finally {
    btn.disabled = false;
    if (typeof prevTransform !== 'undefined') {
      PAGE.style.transform = prevTransform;
      PAGE.style.marginBottom = prevMarginBottom;
    }
    setTimeout(() => (btn.textContent = 'Download PDF'), 1600);
  }
});


// Master-Detail Live Sync: Dengarkan pergantian dokumen dari sidepanel
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastGen) {
    lastGen = changes.lastGen.newValue || null;
    undoStacks.cv = [];
    undoStacks.cl = [];
    render();
    if (currentZoom !== '100') applyZoom(currentZoom);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'RELOAD_DOC') {
    load();
  }
});

load();
