# Networking Hub

A macOS desktop app that works as an AI-powered career command center for college students: it aggregates job and internship postings from multiple sources, scores them against your resume, researches companies, recommends people to network with, forecasts upcoming recruiting cycles, and generates study courses for the roles you're targeting.

Built with Electron and the Anthropic API (Claude).

## Features

- **Opportunity feed** — postings from 12 sources: Greenhouse, Lever, Ashby, SmartRecruiters, and Workable boards, Hacker News "Who's Hiring", The Muse, Remotive, arbitrary careers pages (AI-extracted), plus Google Jobs, USAJobs, and Adzuna behind optional free keys. Filters for internships, fellowships, entry-level, and location; auto-refreshes every 4 hours and notifies on strong fits.
- **AI matching** — scores every posting 0-100 against your profile and resume, in parallel batches, with a one-line reason per match.
- **Built-in assistant** — a popup chat grounded in whatever you're looking at: a lesson, your resume, a project, or your whole job hunt. Conversations can be saved and resumed later.
- **Company deep dives** — research briefs built from Google News RSS, SEC EDGAR filings (10-Ks/8-Ks for finance prep), and Claude's live web search.
- **Suggested contacts** — AI web searches for shared-school alumni at your best-fit companies, target-role folks, and recruiters, with opener ideas. Leads append to a persistent list and are clearly labeled unverified.
- **Contact CRM** — track outreach status, get follow-up reminders, and generate researched, personalized outreach emails.
- **Forecast** — predicts which roles and programs open next, combining your feed's posting history with known recruiting cycles (tech internships, IB summer analyst timelines, and so on).
- **Learn** — generates full courses for any target role (every lesson written in one pass), guided lessons from uploaded syllabi, per-lesson quizzes and videos, flashcard review, and hard portfolio projects that each earn a resume line.

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
