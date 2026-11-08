# Skillsy - AI Career Copilot

Skillsy is a local-first browser extension (Manifest V3) that analyzes job postings against your profile, evaluates your skill fit, and generates tailored single-page A4 resumes and authentic cover letters in PDF format.

Official Website: [skillsy.my.id](https://skillsy.my.id)

---

## Key Features

- **DOM-Based Job Parsing:** One-click extraction of job title, company, requirements, and responsibilities directly from active job tabs.
- **Deterministic Match Scoring:** Evaluates experience alignment, required skills, and competencies against explicit job criteria.
- **Single-Page A4 PDF Resume:** Produces clean, professional, ATS-friendly resumes rendered client-side.
- **Role-Specific Cover Letters:** Generates concise, customized cover letters without generic filler.
- **Local Application Tracking:** Saves, tracks, and manages your job application history directly in your browser.
- **Bring Your Own Key (BYOK):** Direct inference calls from browser to AI providers (Groq, Qwen, or OpenAI-compatible endpoints).

---

## Installation Guide (Chrome, Brave, Edge)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/raybunaken/skillsy.git
   ```
   *(Or click **Code > Download ZIP** and extract the folder).*

2. Open your browser and go to `chrome://extensions` or `brave://extensions`.
3. Enable the **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked** and select the `skillsy` folder.
5. The Skillsy icon will appear in your extensions toolbar. Click it to open the side panel.

---

## Quick Configuration

1. Open the Skillsy side panel.
2. Go to the **Settings** tab.
3. Enter your AI API key:
   - **Groq:** Free API key from [console.groq.com/keys](https://console.groq.com/keys).
   - **Alibaba Cloud Model Studio (Qwen):** Via Alibaba Cloud DashScope console.
4. Click **Simpan Pengaturan**. The key is stored locally in `chrome.storage.local`.

---

## Privacy by Design

- **Zero Remote Document Storage:** Your uploaded CV text is processed in memory and stored locally in browser storage.
- **Direct Client Calls:** API requests originate directly from your browser to the AI provider without intermediary proxy servers.
- **Zero Tracking:** No personal resumes, job postings, or activity logs are collected.

---

## License

This project is licensed under the MIT License.
