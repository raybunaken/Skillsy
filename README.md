<div align="center">

<img src="assets/logo.svg" alt="Skillsy Logo" width="88" height="88" />

# Skillsy

### Client-Side AI Career Copilot for LinkedIn and Job Boards

A local-first browser extension (Manifest V3) that parses job postings directly from active tabs, generates tailored single-page A4 PDF resumes and authentic cover letters, and lets you edit or refine text in real-time with an interactive floating AI bubble.

[Website](https://skillsy.my.id) | [Download ZIP](https://skillsy.my.id/skillsy-extension.zip) | [Quick Setup](#installation) | [Interactive Editor](#interactive-document-editor--ai-selection-bubble) | [Architecture](#architecture) | [Security](#privacy-and-security-guarantees)

<br/>

[![Version](https://img.shields.io/badge/version-0.8.0-00DC82.svg?style=flat-square)](https://github.com/raybunaken/Skillsy)
[![Manifest](https://img.shields.io/badge/manifest-v3-0284c7.svg?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Platform](https://img.shields.io/badge/platform-Chrome%20%7C%20Brave%20%7C%20Edge-f97316.svg?style=flat-square)](https://skillsy.my.id)
[![Architecture](https://img.shields.io/badge/architecture-Local--First%20%2F%20BYOK-8b5cf6.svg?style=flat-square)](https://skillsy.my.id)
[![Inference](https://img.shields.io/badge/inference-Groq%20%7C%20Qwen-10b981.svg?style=flat-square)](https://console.groq.com)
[![License](https://img.shields.io/badge/license-MIT-64748b.svg?style=flat-square)](LICENSE)

</div>

<br/>

## Overview

Most AI resume tools operate as centralized SaaS applications: your full employment history and personal contact details are stored in remote databases, and generated outputs frequently fabricate metrics, produce rigid static text, or overflow onto awkward multi-page formats that break Applicant Tracking Systems (ATS).

Skillsy takes a local-first engineering approach:

- **Local Execution:** PDF parsing, DOM extraction, and profile storage happen entirely inside your browser runtime.
- **Interactive Inline Editor:** Generates live documents with full direct editing (like Word) plus a floating AI revision bubble that triggers on text selection.
- **Strict Anti-Fabrication Engine:** The prompt pipeline enforces hard constraints against inventing titles, companies, or credentials. Real accomplishments are framed optimally, never hallucinated.
- **Deterministic 1-Page Layout:** CV generation produces a standardized single-page A4 PDF rendered directly via client-side Canvas and html2pdf.
- **Bring Your Own Key (BYOK):** Direct client-to-API communication with LLM providers (Groq, Qwen, or any OpenAI-compatible API) with zero intermediary proxy servers.

---

## Interactive Document Editor & AI Selection Bubble

Skillsy includes a built-in document viewer and interactive editor that transforms static AI outputs into a dynamic, word-processor-like experience:

1. **Direct Canvas Editing:** Click anywhere on the generated CV or cover letter to edit text, adjust bullet points, or fix dates directly on the A4 page with instant auto-save to local storage.
2. **Contextual Floating AI Bubble:** Highlight any sentence, bullet point, or paragraph on the preview page. A smart floating toolbar appears directly at the cursor position powered by the browser CSS Custom Highlight API.
3. **One-Click Refinement Chips:**
   - **Ringkas:** Tightens prose and trims unnecessary fluff.
   - **Formal:** Converts wording into authoritative, professional corporate phrasing.
   - **Bahasa:** Corrects grammar and syntax without altering factual meaning.
   - **Fokus Angka:** Reframes bullet points to emphasize quantifiable achievements and metrics.
4. **Custom Prompt Instructions:** Type specific natural language instructions (e.g., "Rephrase using the STAR method", "Emphasize Kubernetes leadership") directly into the bubble.
5. **Side-by-Side Diff Comparison:** Inspect proposed AI revisions against the original text before choosing to Accept or Reject changes.
6. **Multi-Bullet Structure Preservation:** Intelligently recognizes HTML list hierarchies (`<ul>`, `<li>`) so bulleted experience blocks retain clean indentation and typography.

---

## Core Capabilities

- **One-Click DOM Extraction:** Reads role titles, company names, job descriptions, and qualification requirements directly from LinkedIn tabs without scraping account credentials.
- **Floating AI Selection Bubble:** Highlights and refines specific sentences or sections on-demand without regenerating the entire document.
- **Single-Page PDF Resume Generation:** Generates clean, ATS-compliant resumes with responsive typography and professional layout.
- **Contextual Cover Letters:** Formulates role-specific cover letters highlighting genuine qualifications without generic filler or cliches.
- **Multiple CV Design Templates:** Choose between clean visual layouts tailored for corporate, tech, or creative roles.
- **In-Browser Job Tracking:** Built-in history management allowing users to track application status (Saved, Applied, Interviewing, Rejected) locally.
- **Multi-Model Support:** Native support for high-throughput inference providers including Groq (Llama 3.3) and Alibaba Cloud DashScope (Qwen 2.5).

---

## Architecture

```
+------------------------------------------------------------------+
| Browser Runtime (Chrome / Brave / Edge)                          |
|                                                                  |
|  +------------------------+      +----------------------------+  |
|  | Active Job Tab (DOM)   |      | Skillsy Sidepanel UI       |  |
|  | - LinkedIn Job Details | ---> | - Profile Manager          |  |
|  | - Requirements & Title |      | - Document Generator       |  |
|  +------------------------+      +--------------+-------------+  |
|                                                 |                |
|  +----------------------------------------------+                |
|  | Interactive Document Viewer & Editor                          |
|  | - Live Document Editing (contenteditable)                     |
|  | - Floating AI Selection Bubble (CSS Custom Highlights)        |
|  | - One-Click Chips: Concise | Formal | Grammar | Metrics       |
|  | - Side-by-Side Diff Inspector & Multi-Bullet Parser           |
|  +----------------------------------------------+                |
|                                                 |                |
|  +----------------------------------------------+                |
|  | Client-Side Storage: chrome.storage.local                     |
|  | - Base Profile JSON                                           |
|  | - Encrypted Local API Key                                     |
|  | - Local Application History & Auto-Saved Edits                |
|  +----------------------------------------------+                |
+-------------------------------------------------|----------------+
                                                  |
                                                  v Direct HTTPS (BYOK)
                                    +------------------------------+
                                    | AI Inference Provider        |
                                    | - Groq API (console.groq.com)|
                                    | - Alibaba Cloud Qwen / Custom|
                                    +------------------------------+
                                                  |
                                                  v
                                    +------------------------------+
                                    | Single-Page A4 PDF Output    |
                                    | (html2pdf.bundle.min.js)     |
                                    +------------------------------+
```

---

## Installation

### Method 1: Pre-Built ZIP Package (Fastest)

1. Download the latest build: [skillsy-extension.zip](https://skillsy.my.id/skillsy-extension.zip).
2. Unpack the ZIP archive to a folder of your choice.
3. Open your browser and navigate to:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
4. Toggle **Developer mode** on in the top-right corner.
5. Click **Load unpacked** and select the unpacked directory.

### Method 2: Build From Source

```bash
git clone https://github.com/raybunaken/Skillsy.git
cd Skillsy
```
Load the root repository directory via your browser extensions management page.

---

## Configuration & Pricing Model

### Current: Open Source & BYOK (Free Forever)

Skillsy connects directly from your browser to AI inference providers:

1. Click the Skillsy icon in your browser toolbar to open the sidepanel.
2. Select the **Settings** tab.
3. Input your API key:
   - **Groq (Free tier available):** Create a key at [console.groq.com/keys](https://console.groq.com/keys).
   - **Alibaba Cloud Model Studio (Qwen):** Available via Alibaba Cloud DashScope console.
4. Click **Simpan Pengaturan**. The key is saved locally in `chrome.storage.local`.

### Upcoming: Managed Cloud AI (Optional Paid Plan)

For users who prefer not to manage their own API keys or configure developer consoles, a managed cloud tier is planned:
- Zero setup: install from the Chrome Web Store and start generating immediately.
- Hosted inference credits managed directly by Skillsy.
- The open-source BYOK version will remain free and fully supported for developers and privacy-focused users.

---

## Repository Structure

```
Skillsy/
|-- manifest.json          # Manifest V3 extension configuration
|-- background/
|   `-- service-worker.js  # Background life-cycle and sidepanel routing
|-- content/
|   `-- linkedin.js        # Read-only DOM extractor for LinkedIn postings
|-- sidepanel/
|   |-- sidepanel.html     # Main sidepanel interface
|   |-- sidepanel.css      # Dark-mode Apple HIG inspired UI styling
|   |-- sidepanel.js       # Core state management and LLM dispatching
|   |-- prompts.js         # Anti-fabrication prompt templates
|   |-- profile.html       # Profile editor interface
|   |-- profile.js         # Base profile controller
|   |-- viewer.html        # Interactive A4 PDF document previewer
|   `-- viewer.js          # Direct document editor and floating AI selection bubble
|-- lib/
|   |-- html2pdf.bundle.min.js # Client-side PDF canvas generator
|   |-- pdf.min.js             # Client-side PDF parser
|   `-- pdf.worker.min.js      # Background web worker for parsing
|-- assets/
|   `-- logo.svg           # High-resolution brand vector
|-- LICENSE                # MIT License
`-- README.md              # Technical documentation
```

---

## Privacy and Security Guarantees

- **Zero Remote Document Storage:** Your uploaded CV text is processed in memory and stored locally in browser storage.
- **Client-Direct Calls:** API requests to Groq or DashScope originate directly from your browser runtime, not through intermediary servers.
- **Zero Tracker Policy:** No third-party trackers, telemetry scripts, or analytics beacons.

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
