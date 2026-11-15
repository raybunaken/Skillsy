// JobFeast content script - membaca lowongan dari halaman LinkedIn yang sedang dibuka user.
// Read-only: tidak mengirim apa pun ke halaman dan tidak mengubah apa pun,
// kecuali mengeklik tombol "see more" agar deskripsi lowongan terbaca penuh.
//
// Prinsip performa (penting: DOM LinkedIn bisa puluhan ribu elemen, dan
// ekstraksi berjalan di beberapa frame):
//   1. Pemetaan SEMUA root (dokumen + iframe same-origin + shadow root)
//      dilakukan SEKALI per percobaan lewat allRoots(), bukan per selector.
//   2. Penyaringan kandidat memakai textContent (murah, tanpa reflow);
//      innerText (mahal, paksa reflow) hanya untuk elemen terpilih.
//   3. Jumlah kandidat dan level pendakian dibatasi.
// Strategi penemuan tetap bebas-kelas: selector berlapis, jangkar heading
// "About the job", deteksi judul lewat tipografi, dan fallback judul dokumen.

(() => {
  // Self-healing guard: perbarui listener jika diinjeksi ulang setelah extension reload
  if (window.__skillsyRuntimeId === chrome.runtime.id && window.__skillsyLoaded) return;
  window.__skillsyRuntimeId = chrome.runtime.id;
  window.__skillsyLoaded = true;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const TITLES = [
    'h1.t-24',
    '.job-details-jobs-unified-top-card__job-title h1',
    'h1.job-details-jobs-unified-top-card__job-title',
    '.job-details-jobs-unified-top-card__job-title',
    'h2.job-details-jobs-unified-top-card__job-title',
    'h1.top-card-layout__title',
    'h1.topcard__title',
    '[class*="job-title"]',
    'h1[class*="top-card"]',
    '[role="heading"][aria-level="1"]',
    '[class*="job-details"] h1',
    '[class*="job-details"] h2',
    'h1',
  ];
  const COMPANIES = [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    'a.topcard__org-name-link',
    'a[data-tracking-control-name*="company_name"]',
    '[class*="primary-description"] a[href*="/company"]',
    '[class*="company-name"] a',
    '[class*="company-name"]',
    'a[href*="/company/"]',
  ];
  const METAS = [
    '[class*="primary-description"]',
    '.jobs-unified-top-card__primary-description',
    '[class*="top-card"] [class*="company"]',
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.job-details-jobs-unified-top-card__job-insight',
  ];
  const DESCS = [
    '#job-details',
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.jobs-box__html-content',
    '[class*="jobs-box__html-content"]',
    '[class*="jobs-description-content"]',
    '[class*="jobs-description__container"]',
    '.show-more-less-html__markup',
    '.show-more-less-html',
    '[class*="job-description"]',
    '[class*="jobs-description"]',
    'section[class*="description"]',
    'article[class*="description"]',
    '.jobs-description',
  ];
  const SEE_MORE = [
    '.jobs-description__footer-button',
    'button[aria-label*="see more" i]',
    'button[data-tracking-control-name*="show_more"]',
    'button[data-tracking-control-name*="see_more"]',
    'button[data-tracking-control-name*="about_the_job"]',
    '.show-more-less-html__button',
  ];

  const isVisible = (el) => el && (el.offsetParent !== null || el.getClientRects().length > 0);
  const textOf = (el) => (el && el.textContent ? el.textContent : '');

  // ---------- pemetaan root (sekali jalan) ----------
  function allRoots(root, acc, depth) {
    if (depth > 12 || !root.querySelectorAll) return;
    acc.roots.push(root);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        acc.shadow++;
        allRoots(el.shadowRoot, acc, depth + 1);
      }
    }
  }

  function collectAllRoots() {
    const acc = { roots: [], shadow: 0 };
    const bases = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try {
        if (f.contentDocument && f.contentDocument.body) bases.push(f.contentDocument);
      } catch (_) { /* iframe lintas origin: dilewati */ }
    }
    for (const b of bases) allRoots(b, acc, 0);
    return acc;
  }

  // ---------- pencarian ----------
  const firstVisibleIn = (rootEl, selectors) => {
    for (const sel of selectors) {
      for (const el of rootEl.querySelectorAll(sel)) {
        if (isVisible(el) && clean(textOf(el))) return el;
      }
    }
    return null;
  };

  function findDeep(selectors, ctx) {
    for (const sel of selectors) {
      for (const root of ctx.roots) {
        for (const el of root.querySelectorAll(sel)) {
          if (isVisible(el) && clean(textOf(el))) return el;
        }
      }
    }
    return null;
  }

  /* ---------- strategi struktural (bebas kelas) ---------- */

  const ABOUT_JOB_RE = /^\s*(about (the|this) (job|role|position)|tentang (pekerjaan|lowongan|posisi) ini|job description|deskripsi (pekerjaan|lowongan)|description)\b/i;
  const ABOUT_COMPANY_RE = /about (the|this) company|tentang perusahaan/i;

  // Deskripsi: jangkar heading "About the job", lalu blok teks TERBESAR yang
  // tidak menjalar ke section lain. Pemindaian memakai textContent + batas
  // kandidat; innerText hanya untuk elemen terpilih.
    function cleanDescriptionText(t) {
    if (!t) return '';
    const match = t.match(ABOUT_COMPANY_RE);
    if (match && match.index > 80) {
      return t.slice(0, match.index).trim();
    }
    return t;
  }

  function descriptionFromAboutHeading(ctx) {
    for (const root of ctx.roots) {
      for (const el of root.querySelectorAll('h2, h3')) {
        if (!isVisible(el) || !ABOUT_JOB_RE.test(clean(textOf(el)))) continue;

        // 1. Sibling langsung atau sibling dari parent heading
        let candidate = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
        if (candidate) {
          const t = cleanDescriptionText(clean(textOf(candidate)));
          if (t.length >= 80) return candidate;
        }

        // 2. Container pembungkus terdekat (section, article, div)
        const sec = el.closest('section, article, [class*="description"], [class*="details"]');
        if (sec) {
          const t = cleanDescriptionText(clean(textOf(sec)));
          if (t.length >= 120) return sec;
        }

        // 3. Pendakian bertingkat mencari elemen teks terbesar
        let p = el.parentElement;
        for (let level = 0; level < 4 && p; level++) {
          let best = null;
          let checked = 0;
          for (const child of p.querySelectorAll('div, p, section, article, ul, [class*="content"]')) {
            if (++checked > 500) break;
            if (child === el || child.contains(el)) continue;
            const t = clean(textOf(child));
            if (t.length < 80) continue;
            if (ABOUT_COMPANY_RE.test(t)) continue;
            if (!best || t.length > best.len) best = { el: child, len: t.length };
          }
          if (best) {
            const text = clean(best.el.innerText || textOf(best.el));
            if (text.length >= 80) return best.el;
          }
          p = p.parentElement;
        }
      }
    }
    return null;
  }

  // Tombol "see more": kelas standar dulu, lalu tombol dengan teks/aria cocok.
  // Frasa dibatasi spesifik supaya tidak salah klik menu "More" LinkedIn.
  function clickSeeMore(ctx) {
    for (const sel of SEE_MORE) {
      let btn = document.querySelector(sel);
      if (!btn) btn = findDeep([sel], ctx);
      if (btn && isVisible(btn)) {
        try { btn.click(); } catch (_) {}
        return true;
      }
    }
    for (const root of ctx.roots) {
      for (const b of root.querySelectorAll('button')) {
        if (!isVisible(b)) continue;
        const label = clean((b.getAttribute('aria-label') || '') + ' ' + clean(textOf(b)));
        if (label.length > 40) continue;
        if (/see more|show more|lihat selengkapnya|tampilkan selengkapnya|selengkapnya|lihat lebih banyak/i.test(label)) {
          try { b.click(); } catch (_) {}
          return true;
        }
      }
    }
    return false;
  }

  // Judul: layout baru tidak memakai heading. Deteksi lewat tipografi:
  // teks pendek yang dirender besar dan tebal. textContent untuk filter cepat.
  const TITLE_NOISE_RE = /notifications|job alerts|helpful|reach out|company photos|interested in working|about (the|this)? ?(job|company)|sign in|welcome/i;

  function titleByTypography(ctx) {
    let checked = 0;
    for (const root of ctx.roots) {
      for (const el of root.querySelectorAll('h1, h2, h3, h4, span, div, a, p')) {
        if (++checked > 4000) return null;
        if (!isVisible(el)) continue;
        const t = clean(textOf(el));
        if (t.length < 3 || t.length > 90 || TITLE_NOISE_RE.test(t)) continue;
        const doc = el.ownerDocument;
        const win = doc.defaultView || window;
        if (!win || !win.getComputedStyle) continue;
        const cs = win.getComputedStyle(el);
        const fs = parseFloat(cs.fontSize) || 0;
        const fw = parseInt(cs.fontWeight, 10) || 400;
        if (fs >= 18 && fw >= 600) return el;
      }
    }
    return null;
  }

  // Judul cadangan terakhir: judul dokumen "Judul Lowongan | LinkedIn".
  function titleFromDocumentTitle() {
    let t = clean(document.title)
      .replace(/\s*\|\s*LinkedIn\s*$/i, '')
      .replace(/^\(\d+\)\s*/, '');
    if (t && t.length >= 3 && t.length <= 90 && !/linkedin/i.test(t)) return t;
    return '';
  }

  // Panel detail lowongan bisa di-render di container mana pun tergantung layout (termasuk split search layout).
  const detailsRoot = () =>
    document.querySelector('.scaffold-layout__detail') ||
    document.querySelector('.jobs-search__job-details--container') ||
    document.querySelector('.jobs-search__job-details') ||
    document.querySelector('.job-view-layout') ||
    document.querySelector('[class*="job-details-jobs-unified-top-card"]') ||
    document.querySelector('[class*="job-details"]') ||
    document.querySelector('main') ||
    document;

  function extractJob() {
    const ctx = collectAllRoots();

    // buka deskripsi penuh sebelum membaca
    clickSeeMore(ctx);

    const r = detailsRoot();
    
    // 1. Ambil Judul Pekerjaan (prioritaskan container panel detail)
    let title = clean(firstVisibleIn(r, TITLES)?.textContent);
    if (!title && r !== document) {
      const h1 = r.querySelector('h1') || r.querySelector('[class*="job-title"]');
      if (h1 && isVisible(h1)) title = clean(h1.textContent);
    }
    if (!title) {
      title = clean(firstVisibleIn(document, TITLES)?.textContent) || clean(document.querySelector('h1')?.textContent);
    }

    // 2. Ambil Nama Perusahaan
    let companyEl = firstVisibleIn(r, COMPANIES);
    if (!companyEl && r !== document) {
      companyEl = r.querySelector('.job-details-jobs-unified-top-card__company-name a') ||
                  r.querySelector('.job-details-jobs-unified-top-card__company-name') ||
                  r.querySelector('a[href*="/company/"]') ||
                  r.querySelector('[class*="company-name"]');
    }
    if (!companyEl) companyEl = firstVisibleIn(document, COMPANIES);

    // 3. Ambil Metadata (Lokasi / Workplace)
    let metaEl = firstVisibleIn(r, METAS) || firstVisibleIn(document, METAS);

    // 4. Ambil Deskripsi Pekerjaan
    let descEl = firstVisibleIn(r, DESCS) || firstVisibleIn(document, DESCS);

    // Jika belum ditemukan di light DOM standar, coba cari container teks terbesar di dalam detail panel
    if (!descEl && r !== document) {
      for (const sel of ['#job-details', '.jobs-description__content', '.jobs-box__html-content', '[class*="description"]', 'article']) {
        const found = r.querySelector(sel);
        if (found && clean(found.innerText || textOf(found)).length >= 80) {
          descEl = found;
          break;
        }
      }
    }

    // Turun ke strategi dalam jika masih belum lengkap
    if (!title || !descEl) {
      if (!title) title = clean(findDeep(TITLES, ctx)?.textContent) || clean(findDeep(['h1'], ctx)?.textContent);
      if (!companyEl) companyEl = findDeep(COMPANIES, ctx);
      if (!metaEl) metaEl = findDeep(METAS, ctx);
      if (!descEl) descEl = findDeep(DESCS, ctx);
    }
    if (!title) title = clean(titleByTypography(ctx)?.innerText) || titleFromDocumentTitle();
    if (!descEl) descEl = descriptionFromAboutHeading(ctx);

    const company = clean(companyEl?.innerText || textOf(companyEl));
    const metaParts = clean(metaEl?.innerText || textOf(metaEl)).split('·').map(clean).filter(Boolean);
    const loc = metaParts[1] || '';
    const workplace = metaParts[2] || '';
    const description = clean(cleanDescriptionText(descEl?.innerText || textOf(descEl)));
    const jobId = new URLSearchParams(window.location.search).get('currentJobId') || '';

    const ok = Boolean(title && (company || metaParts[0]) && description.length > 50);
    return {
      ok,
      error: ok ? '' : diag({ title, company: company || metaParts[0], description, ctx }),
      job: {
        title,
        company: company || metaParts[0] || '',
        location: loc,
        workplace,
        jobId,
        url: window.location.href,
        description: description.slice(0, 12000),
        scrapedAt: new Date().toISOString(),
      },
    };
  }

  // Inventaris DOM untuk diagnostik: dipakai hanya saat ekstraksi gagal, supaya
  // satu pesan error berisi informasi cukup untuk menulis selector yang pasti.
  function survey(ctx) {
    const lines = [];
    try {
      const heads = [];
      outer: for (const root of ctx.roots) {
        for (const el of root.querySelectorAll('h1, h2, h3')) {
          if (heads.length >= 12) break outer;
          if (!isVisible(el)) continue;
          const t = clean(textOf(el));
          if (t) heads.push(el.tagName + '=' + t.slice(0, 50));
        }
      }
      lines.push('HEADINGS: ' + (heads.join(' | ') || 'tidak ada'));
    } catch (_) { lines.push('HEADINGS: error'); }
    try {
      const srcs = [...document.querySelectorAll('iframe')].map((f) => (f.src || 'about:blank').slice(0, 90));
      lines.push('IFRAME: ' + (srcs.join(' | ') || 'tidak ada'));
    } catch (_) { lines.push('IFRAME: error'); }
    return lines.join(' ;; ');
  }

  function diag({ title, company, description, ctx }) {
    const ada = (v) => (v ? 'terbaca' : 'kosong');
    return (
      'Skillsy belum berhasil membaca lowongan (judul=' + ada(title) +
      ', perusahaan=' + ada(company) +
      ', deskripsi=' + (description ? description.length + ' karakter' : 'kosong') +
      ', shadowDOM=' + ctx.shadow +
      ', iframe=' + document.querySelectorAll('iframe').length +
      ', url=' + window.location.pathname + '). ' +
      'Salin pesan ini ke pengembang. Detail teknis: ' + survey(ctx)
    );
  }

  async function extractJobWithRetry() {
    for (let i = 0; i < 4; i++) {
      const r = extractJob();
      if (r.ok) return r;
      await sleep(300);
    }
    return extractJob();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_JOB') {
      extractJobWithRetry()
        .then((r) => {
          sendResponse(r);
        })
        .catch((e) => {
          sendResponse({ ok: false, error: 'Ekstraksi error: ' + (e && e.message || String(e)) });
        });
      return true;
    }
    if (msg.type === 'GET_JOB_DIAG') {
      try {
        sendResponse(extractJob());
      } catch (e) {
        sendResponse({ ok: false, error: 'Diagnostik gagal: ' + String(e && e.message || e) });
      }
      return false;
    }
  });
})();
