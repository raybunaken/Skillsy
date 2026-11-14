# Skillsy - Honest AI Career Copilot for LinkedIn

Cross-browser extension (Chrome MV3 + Firefox) yang membaca **lowongan dari halaman LinkedIn yang sedang kamu buka**, lalu membuat **CV 1 halaman A4 + cover letter yang dipersonalisasi untuk lowongan itu** - jujur, tanpa mengarang - langsung jadi **PDF**.

> **Penting soal API key**: Skillsy adalah BYOK (bring your own key). Key kamu disimpan hanya di browser kamu (`chrome.storage.local`). **Jangan pernah** commit API key ke repo ini atau menempelkannya di issue/screenshot. Key yang pernah bocor wajib di-revoke di provider masing-masing (Groq / DashScope / OpenAI).

## Untuk kontributor dan AI agent

Seluruh konteks desain, strategi bisnis, keputusan arsitektur, pelajaran debug (terutama soal ekstraksi LinkedIn), protokol testing, dan alur rilis ada di [AGENTS.md](AGENTS.md). Baca dulu sebelum mengubah apa pun.

## Cara kerja

```
┌─────────────┐     job posting     ┌──────────────┐
│  LinkedIn   │ ──────────────────▶ │   Skillsy    │
│ (tab aktif) │   (read-only DOM)   │  sidepanel   │
└─────────────┘                     └──────┬───────┘
                                           │ profile + job
                                           ▼
                                    ┌──────────────┐
           PDF (Downloads/Skillsy/) │   LLM API    │
           CV · Cover Letter ◀───── │ (Groq / Qwen)│
                                    └──────────────┘
```

1. **Sekali setup** - upload CV dasar kamu (PDF) atau buat lewat wawancara chat interaktif. AI mengubahnya menjadi **profil terstruktur** (JSON, bisa diedit). Profil ini adalah *single source of truth*.
2. **Saat apply** - buka lowongan di LinkedIn, klik "Ambil dari tab LinkedIn ini", klik "Buat CV + Cover Letter".
3. **Periksa & simpan** - preview bisa diedit langsung; pemeriksa kejujuran menandai angka/skill yang tidak ada di profil; download otomatis dua PDF masuk ke folder `Downloads/Skillsy/`.

## Jaminan kejujuran (fitur inti)

Skillsy dirancang untuk **mempersonalisasi, bukan mengarang**. Tiga lapis:

| Lapis | Cara |
|---|---|
| 1. Prompt | Instruksi keras: hanya fakta dari profil; angka wajib disalin persis; kebutuhan lowongan yang tidak ada di profil dilewati, bukan diklaim |
| 2. Validator | Setelah generate, semua **angka metrik** (%, ribuan, "x") dan **item skill** dicocokkan ke profil via regex dan token matching; yang tidak ketemu di-flag merah di preview |
| 3. Human-in-the-loop | Preview selalu bisa diedit sebelum download; ada balon revisi AI untuk teks yang diblok; tidak ada auto-submit |

## Instalasi

### Chrome / Edge / Brave (Developer Mode)
1. Buka `chrome://extensions` lalu aktifkan **Developer mode** di pojok kanan atas.
2. Klik **Load unpacked**, pilih folder ekstensi Skillsy ini.
3. Klik ikon Skillsy di toolbar browser, side panel akan terbuka.

### Firefox
1. Buka `about:debugging#/runtime/this-firefox`.
2. Klik **Load Temporary Add-on** lalu pilih file `manifest.json`.
3. Klik ikon Skillsy di toolbar (atau menu View -> Sidebar).

### Setup pertama
1. Tab **Settings**: tempel API key (misal Groq gratis di [console.groq.com](https://console.groq.com/keys)).
2. Tab **Profil**: upload PDF CV atau ikuti panduan chat untuk mengisi pengalamanmu.
3. Buka lowongan mana pun di LinkedIn, buka Skillsy, klik **Generate**.

## Privasi

- Profil, riwayat generate, dan API key hanya tersimpan di `chrome.storage.local` - **tidak ada server perantara**.
- Data hanya keluar dari browser saat kamu menekan generate: teks lowongan + profil dikirim langsung ke endpoint LLM resmi.
- Content script bersifat **read-only** terhadap LinkedIn: hanya membaca teks lowongan yang kamu buka, tidak mengirim atau mengubah apa pun di akun LinkedIn kamu.

## Struktur

```
skillsy/
├── manifest.json                  # Cross-browser MV3
├── background/service-worker.js   # Jalur fetch LLM (retry on 429, OpenAI compatible)
├── content/linkedin.js            # Ekstraksi lowongan dari DOM (multi-frame + self-healing)
├── sidepanel/                     # UI utama: Generate · Profil · Riwayat · Settings
│   ├── sidepanel.html/css/js      # Pipeline generate, validator kejujuran, one-page fit
│   ├── prompts.js                 # Prompt sistem bersama (PARSE_SYSTEM, GEN_SYSTEM)
│   ├── viewer.html/js             # Full-page document editor (diff, undo stack, revisi AI)
│   └── profile.html/js            # Full-page profile editor + mode wawancara interaktif
└── lib/                           # pdf.js (baca CV) + html2pdf.js (buat PDF A4)
```

## Lisensi

MIT - bebas dipakai, difork, dan dikembangkan.
