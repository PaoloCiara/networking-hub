'use strict';

// Opportunity fetchers. Key-less sources: Greenhouse, Lever, Ashby,
// SmartRecruiters, Workable (per-company board slugs), HN Who's Hiring,
// The Muse, Remotive, and arbitrary careers pages (AI-extracted). Optional
// free keys unlock Google Jobs (SerpAPI), USAJobs, and Adzuna.

const ai = require('./ai');

const FETCH_TIMEOUT_MS = 15000;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function matchesKeywords(text, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const haystack = (text || '').toLowerCase();
  return keywords.some(k => haystack.includes(k.toLowerCase()));
}

// Normalize scraped titles: collapse whitespace, strip stray punctuation and
// bracketed noise so lists look consistent.
function cleanTitle(raw, max = 90) {
  const t = (raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^\W+|[|,;:\-–\s]+$/g, '')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Company names arrive as "Acme, Inc. (YC W25)" — trim to just "Acme".
function cleanCompany(raw) {
  return cleanTitle(raw, 50)
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[,.]?\s+(inc|llc|ltd|corp|co|gmbh|labs)\.?$/i, '')
    .trim();
}

// ── Greenhouse ────────────────────────────────────────────────────────────────

async function fetchGreenhouse(slug, keywords) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
  return (data.jobs || [])
    .filter(j => matchesKeywords(`${j.title} ${j.location?.name || ''}`, keywords))
    .map(j => ({
      id: `gh-${slug}-${j.id}`,
      source: 'Greenhouse',
      company: slug,
      title: j.title,
      location: j.location?.name || '',
      url: j.absolute_url,
      postedAt: j.updated_at || null,
      kind: 'job',
    }));
}

// ── Lever ─────────────────────────────────────────────────────────────────────

async function fetchLever(slug, keywords) {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(data) ? data : [])
    .filter(j => matchesKeywords(`${j.text} ${j.categories?.location || ''}`, keywords))
    .map(j => ({
      id: `lv-${slug}-${j.id}`,
      source: 'Lever',
      company: slug,
      title: j.text,
      location: j.categories?.location || '',
      url: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      kind: 'job',
    }));
}

// ── Ashby ─────────────────────────────────────────────────────────────────────

async function fetchAshby(slug, keywords) {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return (data.jobs || [])
    .filter(j => j.isListed !== false)
    .filter(j => matchesKeywords(`${j.title} ${j.location || ''}`, keywords))
    .map(j => ({
      id: `ab-${slug}-${j.id}`,
      source: 'Ashby',
      company: slug,
      title: j.title,
      location: j.location || (j.isRemote ? 'Remote' : ''),
      url: j.jobUrl || j.applyUrl || '',
      postedAt: j.publishedAt || null,
      kind: 'job',
    }));
}

// ── SmartRecruiters ───────────────────────────────────────────────────────────

async function fetchSmartRecruiters(slug, keywords) {
  const data = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
  return (data.content || [])
    .filter(j => matchesKeywords(`${j.name} ${j.location?.city || ''}`, keywords))
    .map(j => ({
      id: `sr-${slug}-${j.id}`,
      source: 'SmartRecruiters',
      company: cleanCompany(j.company?.name || slug),
      title: j.name,
      location: [j.location?.city, j.location?.region].filter(Boolean).join(', ')
        || (j.location?.remote ? 'Remote' : ''),
      url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      postedAt: j.releasedDate || null,
      kind: 'job',
    }));
}

// ── Workable ──────────────────────────────────────────────────────────────────

async function fetchWorkable(slug, keywords) {
  const data = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`);
  return (data.jobs || [])
    .filter(j => matchesKeywords(`${j.title} ${j.city || ''}`, keywords))
    .map(j => ({
      id: `wk-${slug}-${j.shortcode || j.code}`,
      source: 'Workable',
      company: cleanCompany(data.name || slug),
      title: j.title,
      location: [j.city, j.state, j.country].filter(Boolean).join(', '),
      url: j.url || `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
      postedAt: j.published_on || null,
      kind: 'job',
    }));
}

// ── Workday ───────────────────────────────────────────────────────────────────
// Big finance/tech employers (BlackRock, NVIDIA, Capital One, Salesforce, …)
// run careers on Workday. Its CXS search endpoint is public JSON — no key.
// Each board is configured as "tenant:datacenter:site", e.g.
//   "blackrock:wd1:BlackRock_Professional", "nvidia:wd5:NVIDIAExternalCareerSite".
// The datacenter (wd1/wd3/wd5/…) and site slug come from the careers URL.

function parseWorkdayBoard(entry) {
  const [tenant, dc, site] = (entry || '').split(':').map(s => s.trim());
  if (!tenant || !dc || !site) return null;
  return { tenant, dc, site };
}

async function fetchWorkday(entry, keywords) {
  const cfg = parseWorkdayBoard(entry);
  if (!cfg) throw new Error(`bad board "${entry}" — expected tenant:datacenter:site`);
  const { tenant, dc, site } = cfg;
  const base = `https://${tenant}.${dc}.myworkdayjobs.com`;
  const api = `${base}/wday/cxs/${tenant}/${site}/jobs`;

  // Workday searches server-side, so run one search per keyword (like the other
  // query-based sources) and merge. Unauthenticated and unmetered, so no quota
  // juggling needed.
  const searches = keywords.length ? keywords : [''];
  const byId = new Map();
  for (const kw of searches) {
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: kw }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    for (const j of (data.jobPostings || [])) {
      if (!j.externalPath) continue;
      const id = `wd-${tenant}-${(j.bulletFields && j.bulletFields[0]) || j.externalPath}`;
      if (byId.has(id)) continue;
      byId.set(id, {
        id,
        source: 'Workday',
        company: cleanCompany(tenant),
        title: cleanTitle(j.title || ''),
        location: j.locationsText || '',
        url: `${base}/en-US/${site}${j.externalPath}`,
        postedAt: null, // Workday reports relative text only ("Posted Today")
        kind: 'job',
      });
    }
  }
  return [...byId.values()];
}

// ── The Muse ──────────────────────────────────────────────────────────────────
// Free aggregator API. Pull the internship and entry-level pages and filter
// by the user's keywords locally.

async function fetchTheMuse(keywords, location) {
  const params = new URLSearchParams({ page: '1' });
  for (const lvl of ['Internship', 'Entry Level']) params.append('level', lvl);
  if (location) params.append('location', location);
  const data = await fetchJson(`https://www.themuse.com/api/public/jobs?${params}`);
  return (data.results || [])
    .filter(j => matchesKeywords(j.name, keywords))
    .map(j => ({
      id: `muse-${j.id}`,
      source: 'The Muse',
      company: cleanCompany(j.company?.name || ''),
      title: cleanTitle(j.name || ''),
      location: (j.locations || []).map(l => l.name).slice(0, 2).join('; '),
      url: j.refs?.landing_page || '',
      postedAt: j.publication_date || null,
      kind: 'job',
      description: (j.contents || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600),
    }));
}

// ── Remotive ──────────────────────────────────────────────────────────────────
// Remote-only board. Remotive asks integrators to keep volume low, so one
// search per refresh using the first keyword.

async function fetchRemotive(keywords) {
  const q = keywords[0] || 'software engineer';
  const data = await fetchJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=50`);
  return (data.jobs || [])
    .filter(j => matchesKeywords(j.title, keywords))
    .map(j => ({
      id: `rmt-${j.id}`,
      source: 'Remotive',
      company: cleanCompany(j.company_name || ''),
      title: cleanTitle(j.title || ''),
      location: j.candidate_required_location || 'Remote',
      url: j.url || '',
      postedAt: j.publication_date || null,
      kind: 'job',
      description: (j.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600),
    }));
}

// ── USAJobs ───────────────────────────────────────────────────────────────────
// Government internships and fellowships (Pathways, PMF, etc.). Free key from
// developer.usajobs.gov; the API requires the registered email as User-Agent.

async function fetchUSAJobs(email, key, keyword, location) {
  const params = new URLSearchParams({ Keyword: keyword, ResultsPerPage: '50' });
  if (location) params.set('LocationName', location);
  const res = await fetch(`https://data.usajobs.gov/api/search?${params}`, {
    headers: { 'Authorization-Key': key, 'User-Agent': email },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data.SearchResult?.SearchResultItems || []).map(item => {
    const d = item.MatchedObjectDescriptor || {};
    return {
      id: `usa-${item.MatchedObjectId}`,
      source: 'USAJobs',
      company: cleanCompany(d.OrganizationName || 'US Government'),
      title: cleanTitle(d.PositionTitle || ''),
      location: d.PositionLocationDisplay || '',
      url: d.PositionURI || '',
      postedAt: d.PublicationStartDate || null,
      kind: 'job',
      description: (d.UserArea?.Details?.JobSummary || '').slice(0, 600),
    };
  });
}

// ── Adzuna ────────────────────────────────────────────────────────────────────
// Aggregated postings with a generous free tier (developer.adzuna.com).

async function fetchAdzuna(appId, appKey, keyword, location) {
  const params = new URLSearchParams({
    app_id: appId, app_key: appKey,
    what: keyword, results_per_page: '30',
  });
  if (location) params.set('where', location);
  const data = await fetchJson(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
  return (data.results || []).map(j => ({
    id: `adz-${j.id}`,
    source: 'Adzuna',
    company: cleanCompany(j.company?.display_name || ''),
    title: cleanTitle(j.title || ''),
    location: j.location?.display_name || '',
    url: j.redirect_url || '',
    postedAt: j.created || null,
    kind: 'job',
    description: (j.description || '').slice(0, 600),
    role: keyword,
  }));
}

// ── Arbitrary careers pages ───────────────────────────────────────────────────
// For companies not on any known ATS: fetch the page, reduce it to text with
// link URLs preserved inline, and let Claude pull out the postings.

function htmlToText(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, ' $2 [$1] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim();
}

const stableKey = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);

async function fetchCareersPage(settings, pageUrl) {
  const res = await fetch(pageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) NetworkingHub/1.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = htmlToText(await res.text());
  const fallbackCompany = new URL(pageUrl).hostname.replace(/^www\./, '').split('.')[0];
  const postings = await ai.extractPostingsFromPage(settings, pageUrl, text);
  return postings
    .filter(p => p && p.title)
    .filter(p => matchesKeywords(p.title, settings.jobKeywords))
    .map(p => ({
      id: `cp-${stableKey(`${p.company || fallbackCompany}-${p.title}`)}`,
      source: 'Careers page',
      company: cleanCompany(p.company || fallbackCompany),
      title: cleanTitle(p.title),
      location: p.location || '',
      url: p.url || pageUrl,
      postedAt: null,
      kind: 'job',
    }));
}

// ── Hacker News "Who is hiring?" ──────────────────────────────────────────────

async function fetchHNWhoIsHiring(keywords) {
  // Find the most recent "Ask HN: Who is hiring?" thread.
  const search = await fetchJson(
    'https://hn.algolia.com/api/v1/search_by_date?query=%22Ask%20HN%3A%20Who%20is%20hiring%3F%22&tags=story&hitsPerPage=5'
  );
  // Match the exact monthly thread ("Ask HN: Who is hiring? (July 2026)") —
  // a loose match can grab the freelancer/seeking-work threads instead.
  const thread = (search.hits || []).find(h => /^Ask HN: Who is hiring\? \(/i.test(h.title || ''));
  if (!thread) return [];

  // Pull the thread's top-level comments (each comment = one job post).
  const item = await fetchJson(`https://hn.algolia.com/api/v1/items/${thread.objectID}`);
  const comments = (item.children || []).filter(c => c.text);

  return comments
    .filter(c => matchesKeywords(c.text, keywords))
    .slice(0, 50)
    .map(c => {
      const plain = c.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      // HN convention: first line is "Company | Role | Location | ..."
      const firstLine = plain.split(/(?<=\.)\s|\n/)[0].slice(0, 160);
      const parts = firstLine.split('|').map(s => s.trim()).filter(Boolean);
      const company = cleanCompany(parts[0] || 'Unknown');
      // Second segment is usually the role; fall back gracefully when the
      // poster didn't follow the convention.
      const role = parts[1] && parts[1].length <= 80 ? cleanTitle(parts[1]) : 'Multiple roles';
      return {
        id: `hn-${c.id}`,
        source: 'HN Who\'s Hiring',
        company,
        title: role === 'Multiple roles' ? `${role} at ${company}` : role,
        location: parts[2] && parts[2].length <= 40 ? cleanTitle(parts[2]) : '',
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        postedAt: c.created_at || null,
        kind: 'job',
        description: plain.slice(0, 600),
      };
    });
}

// ── Google Jobs via SerpAPI ───────────────────────────────────────────────────
// Pulls postings that Google indexes from company career pages across the web.
// Requires a SerpAPI key; skipped silently without one.

async function fetchGoogleJobs(serpApiKey, keyword, location) {
  const params = new URLSearchParams({
    engine: 'google_jobs',
    q: keyword,
    api_key: serpApiKey,
  });
  if (location) params.set('location', location);

  const data = await fetchJson(`https://serpapi.com/search.json?${params}`);
  return (data.jobs_results || []).map(j => {
    // Stable id from company+title so re-fetches don't duplicate.
    const key = `${j.company_name}-${j.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return {
      id: `gj-${key}`,
      source: 'Google Jobs',
      company: cleanCompany(j.company_name || ''),
      title: cleanTitle(j.title || ''),
      location: j.location || '',
      url: j.share_link || j.apply_options?.[0]?.link || '',
      postedAt: null, // Google Jobs reports relative dates only
      kind: 'job',
      description: (j.description || '').slice(0, 600),
      role: keyword,
    };
  });
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

async function fetchAllOpportunities(settings) {
  const {
    greenhouseBoards = [], leverBoards = [], ashbyBoards = [],
    smartrecruitersBoards = [], workableBoards = [], workdayBoards = [],
    careersPages = [],
    jobKeywords = [], serpApiKey = '', jobLocation = '',
    usaJobsEmail = '', usaJobsKey = '', adzunaAppId = '', adzunaAppKey = '',
  } = settings;
  const errors = [];
  const fail = label => e => { errors.push(`${label}: ${e.message}`); return []; };

  // Keyword-search sources get a rotating subset per refresh so quotas last
  // and every keyword still gets coverage over time.
  const rotate = (arr, n) => arr.length <= n
    ? arr
    : [...arr].sort(() => Math.random() - 0.5).slice(0, n);
  const gjKeywords = rotate(jobKeywords, 3);   // SerpAPI: 100 free searches/month
  const adzKeywords = rotate(jobKeywords, 2);

  const tasks = [
    ...greenhouseBoards.map(s => fetchGreenhouse(s, jobKeywords).catch(fail(`Greenhouse/${s}`))),
    ...leverBoards.map(s => fetchLever(s, jobKeywords).catch(fail(`Lever/${s}`))),
    ...ashbyBoards.map(s => fetchAshby(s, jobKeywords).catch(fail(`Ashby/${s}`))),
    ...smartrecruitersBoards.map(s => fetchSmartRecruiters(s, jobKeywords).catch(fail(`SmartRecruiters/${s}`))),
    ...workableBoards.map(s => fetchWorkable(s, jobKeywords).catch(fail(`Workable/${s}`))),
    ...workdayBoards.map(s => fetchWorkday(s, jobKeywords).catch(fail(`Workday/${s}`))),
    fetchHNWhoIsHiring(jobKeywords).catch(fail('HN')),
    fetchTheMuse(jobKeywords, jobLocation).catch(fail('The Muse')),
    fetchRemotive(jobKeywords).catch(fail('Remotive')),
    ...careersPages.map(u => fetchCareersPage(settings, u).catch(fail(`Careers page ${u}`))),
    ...(serpApiKey
      ? gjKeywords.map(k => fetchGoogleJobs(serpApiKey, k, jobLocation).catch(fail(`Google Jobs/${k}`)))
      : []),
    ...(usaJobsKey && usaJobsEmail
      ? ['internship', 'fellowship'].map(k =>
          fetchUSAJobs(usaJobsEmail, usaJobsKey, k, jobLocation).catch(fail(`USAJobs/${k}`)))
      : []),
    ...(adzunaAppId && adzunaAppKey
      ? adzKeywords.map(k => fetchAdzuna(adzunaAppId, adzunaAppKey, k, jobLocation).catch(fail(`Adzuna/${k}`)))
      : []),
  ];

  const results = await Promise.all(tasks);
  // Dedupe by id — sources overlap (an Adzuna hit may also be on Greenhouse)
  // and keyword searches can return the same posting twice.
  const byId = new Map();
  for (const opp of results.flat()) if (!byId.has(opp.id)) byId.set(opp.id, opp);
  return { opportunities: [...byId.values()], errors };
}

module.exports = { fetchAllOpportunities };
