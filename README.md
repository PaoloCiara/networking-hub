# Networking Hub

A macOS desktop app that works as an AI-powered career command center for college students: it aggregates job and internship postings from multiple sources, scores them against your resume, researches companies, recommends people to network with, forecasts upcoming recruiting cycles, and generates study courses for the roles you're targeting.

Built with Electron and the Anthropic API (Claude).

## Features

- **Opportunity feed** — pulls postings from Greenhouse and Lever job boards, Hacker News "Who's Hiring", and Google Jobs (via SerpAPI), with filters for internships, fellowships, entry-level roles, and location. Auto-refreshes every 4 hours and sends a notification when strong fits appear.
- **AI matching** — scores every posting 0-100 against your profile and resume, with a one-line reason per match.
- **Profile & resume** — import a PDF resume, get AI feedback on it, and scan the web for your public mentions.
- **Company deep dives** — one-click research briefs on any company: what they do, recent news and deals, and talking points for outreach.
- **Suggested contacts** — AI plans people searches (shared-school alumni at your best-fit companies, target-role folks, recruiters), pulls public profiles, and drafts opener ideas. Leads are clearly labeled unverified.
- **Contact CRM** — track outreach status, get follow-up reminders, and generate researched, personalized outreach emails.
- **Forecast** — predicts which roles and programs open next, combining your feed's posting history with known recruiting cycles (tech internships, IB summer analyst timelines, and so on).
- **Learn** — generates from-scratch curricula for any target role, or turns an uploaded course syllabus into guided lessons taught in-app.

## Setup

```bash
npm install
npm start          # run in development
npm run dist       # build the .app bundle into dist/mac/
```

Add API keys in the app under **Settings**:

- **Anthropic API key** (required for all AI features) — [console.anthropic.com](https://console.anthropic.com)
- **SerpAPI key** (optional; powers Google Jobs, company news, and people searches) — [serpapi.com](https://serpapi.com), free tier is 100 searches/month

Keys and all data are stored locally in a single JSON file under `~/Library/Application Support/Networking Hub/` — nothing leaves your machine except the API calls themselves.

## Architecture

- `main.js` — Electron main process: window, IPC handlers, follow-up checker, 4-hour auto-refresh
- `preload.js` — contextBridge API surface (contextIsolation on, no nodeIntegration)
- `db.js` — single-file JSON store with an in-memory cache
- `services/jobs.js` — posting fetchers and normalizers for each source
- `services/ai.js` — all Claude calls: matching, research, courses, forecasting, contact recommendations (with JSON prefill, truncation repair, and retry)
- `renderer/` — vanilla JS/HTML/CSS UI, no framework
