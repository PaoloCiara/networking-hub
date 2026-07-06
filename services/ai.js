'use strict';

// AI features: contact research synthesis and outreach-email drafting.
// Both require an Anthropic API key from Settings. Web research additionally
// uses SerpAPI when a key is present; otherwise drafting works from whatever
// context the user typed in (pasted LinkedIn bio, notes, etc.).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

class MissingKeyError extends Error {
  constructor(which) {
    super(`${which} API key not set. Add it in Settings to enable this feature.`);
    this.code = 'MISSING_KEY';
  }
}

// `expect` ('[' or '{') marks calls that must return bare JSON. Claude 5
// models reject assistant-message prefill, so the requirement is restated at
// the end of the user turn instead; extractJson strips any strays that slip
// through. `webSearchUses` > 0 attaches Anthropic's server-side web_search
// tool so Claude can research the open web itself (billed per search) —
// the no-SerpAPI path for company research, leads, and scans.
// Retries once on rate-limit/server errors.
async function callClaude(apiKey, system, userText, maxTokens = 1024, expect = '', webSearchUses = 0) {
  if (expect) {
    userText += `\n\nRespond with raw JSON starting with "${expect}" — no prose before it, no code fences.`;
  }
  const messages = [{ role: 'user', content: userText }];

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
        ...(webSearchUses > 0
          ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: webSearchUses }] }
          : {}),
      }),
      signal: AbortSignal.timeout(webSearchUses > 0 ? 180000 : 90000),
    });

    if ([429, 500, 502, 503, 529].includes(res.status) && attempt === 0) {
      await new Promise(r => setTimeout(r, 2500));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
}

async function searchWeb(serpApiKey, query) {
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=8&api_key=${serpApiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`SerpAPI error ${res.status}`);
  const data = await res.json();
  return (data.organic_results || []).slice(0, 8).map(r =>
    `- ${r.title}: ${r.snippet || ''} (${r.link})`).join('\n');
}

// Research a contact: web search (if SerpAPI key set) + Claude synthesis.
async function researchContact(settings, contact) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  let webContext = '';
  if (settings.serpApiKey) {
    const query = `"${contact.name}" ${contact.company || ''} interview OR announcement OR role`;
    webContext = await searchWeb(settings.serpApiKey, query).catch(e => `(web search failed: ${e.message})`);
  }

  const system =
    'You are a research assistant for professional networking. Given raw search ' +
    'snippets and notes about a person, produce a concise brief: current role, ' +
    'recent public activity (interviews, posts, job changes), and 2-3 specific ' +
    'conversation hooks for a networking email. Be factual; if information is ' +
    'thin, say so rather than inventing details.';

  const userText =
    `Person: ${contact.name} <${contact.email}>\n` +
    `Company: ${contact.company || 'unknown'}\n` +
    `My notes: ${contact.notes || '(none)'}\n\n` +
    `Web search results:\n${webContext || '(no web search available — work from notes only)'}`;

  return callClaude(settings.anthropicApiKey, system, userText);
}

// Draft a personalized outreach email using the research brief.
async function draftEmail(settings, contact, research, tone) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  const system =
    'You write short, genuine networking emails. Rules: under 150 words, one ' +
    'specific personalized hook from the research, one clear low-friction ask ' +
    '(15-minute chat), no flattery padding, no "I hope this finds you well". ' +
    'Output only the subject line (prefixed "Subject: ") and the body.';

  const userText =
    `Recipient: ${contact.name} <${contact.email}>, ${contact.company || ''}\n` +
    `Tone: ${tone || 'warm and direct'}\n` +
    `Research brief:\n${research || contact.notes || '(none — write a solid generic-but-warm note)'}`;

  return callClaude(settings.anthropicApiKey, system, userText);
}

// ── JSON helper ───────────────────────────────────────────────────────────────
// Claude sometimes wraps JSON in code fences or prose; extract the first
// well-formed JSON value from the response.

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let raw = (fenced ? fenced[1] : text).trim();
  const starts = ['[', '{'].map(c => raw.indexOf(c)).filter(i => i >= 0);
  if (starts.length === 0) throw new Error('AI returned no JSON.');
  raw = raw.slice(Math.min(...starts));
  const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
  if (end >= 0) raw = raw.slice(0, end + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return repairJson(raw);
  }
}

// Given JSON truncated by a token limit, walk back to the last structurally
// complete element and close any brackets still open.
function closersFor(fragment) {
  const stack = [];
  let inString = false, escaped = false;
  for (const ch of fragment) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = inString; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return stack.reverse().map(c => (c === '{' ? '}' : ']')).join('');
}

function repairJson(raw) {
  for (let i = raw.length; i > 0; i--) {
    const ch = raw[i - 1];
    if (ch !== '}' && ch !== ']') continue;
    const fragment = raw.slice(0, i);
    try {
      return JSON.parse(fragment + closersFor(fragment));
    } catch { /* walk back to the previous complete element */ }
  }
  throw new Error('AI returned unparseable JSON.');
}

// Pull structured postings out of careers-page text. Used by the generic
// careers-page importer in services/jobs.js; returns [] without a key so a
// feed refresh never hard-fails on this source.
async function extractPostingsFromPage(settings, pageUrl, pageText) {
  if (!settings.anthropicApiKey) return [];

  const system =
    'You extract open job postings from the text of a company careers page. ' +
    'Link URLs appear inline in square brackets after their anchor text; ' +
    'resolve relative URLs against the page URL. Respond with ONLY a JSON ' +
    'array, max 40 items: [{"title": "...", "company": "...", "location": ' +
    '"...", "url": "..."}]. Only real, currently open positions — no nav ' +
    'links, blog posts, or benefits copy. Empty array if none.';

  const text = await callClaude(settings.anthropicApiKey, system,
    `Page URL: ${pageUrl}\n\nPage text:\n${pageText.slice(0, 24000)}`, 3000, '[');
  try { return extractJson(text); } catch { return []; }
}

function profileSummary(profile) {
  return [
    profile.name && `Name: ${profile.name}`,
    profile.school && `School: ${profile.school}, ${profile.major || ''} ${profile.gradYear ? `(class of ${profile.gradYear})` : ''}`,
    profile.location && `Location: ${profile.location}`,
    profile.interests?.length && `Interests: ${profile.interests.join(', ')}`,
    profile.goals && `Career goals: ${profile.goals}`,
    profile.github && `GitHub: ${profile.github}`,
    profile.linkedin && `LinkedIn: ${profile.linkedin}`,
    profile.portfolio && `Portfolio: ${profile.portfolio}`,
    profile.resumeText && `Resume:\n${profile.resumeText.slice(0, 4000)}`,
  ].filter(Boolean).join('\n');
}

// Score fetched opportunities against the user's profile.
// Returns [{ id, score, reason }] — score 0-100.
async function matchOpportunities(settings, profile, opportunities) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  const system =
    'You match job and internship postings to a candidate profile. For each ' +
    'posting, output a fit score 0-100 and a one-sentence reason grounded in ' +
    'the profile (skills, interests, education stage — favor internships and ' +
    'entry-level roles for current students). Respond with ONLY a JSON array: ' +
    '[{"id": "...", "score": 0-100, "reason": "..."}]. Include every posting. ' +
    'Keep each reason under 20 words.';

  const summary = profileSummary(profile) || '(empty profile)';

  // Batch to keep each response comfortably inside the token limit —
  // one oversized reply is what corrupts the JSON.
  const pool = opportunities.slice(0, 120);
  const scores = [];
  for (let i = 0; i < pool.length; i += 30) {
    const list = pool.slice(i, i + 30).map(o => ({
      id: o.id,
      title: o.title,
      company: o.company,
      location: o.location,
      description: (o.description || '').slice(0, 200),
    }));
    const userText =
      `Candidate profile:\n${summary}\n\n` +
      `Postings:\n${JSON.stringify(list, null, 1)}`;
    const text = await callClaude(settings.anthropicApiKey, system, userText, 4000, '[');
    scores.push(...extractJson(text));
  }
  return scores;
}

// Generate a from-scratch curriculum for a target role.
async function courseForRole(settings, profile, role) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  const system =
    'You design compact, practical curricula for college students preparing ' +
    'for a specific job role. Cover the bare-minimum concepts needed to be ' +
    'competent, assuming the student starts from scratch. 3-5 modules, 3-5 ' +
    'lessons each, ordered so each lesson builds on the last. Respond with ' +
    'ONLY JSON: {"title": "...", "modules": [{"title": "...", "lessons": ' +
    '[{"title": "...", "summary": "one sentence"}]}]}.';

  const userText =
    `Target role: ${role}\n\nStudent profile:\n${profileSummary(profile) || '(none)'}`;

  const text = await callClaude(settings.anthropicApiKey, system, userText, 3000, '{');
  return extractJson(text);
}

// Turn an uploaded syllabus into a guided lesson plan.
async function courseFromSyllabus(settings, syllabusText, courseName) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  const system =
    'You turn a college course syllabus into a structured self-study plan. ' +
    'Extract the real topics and order from the syllabus, grouped into ' +
    'modules (by unit/week), each with concrete lessons a student can work ' +
    'through to master the class. Respond with ONLY JSON: {"title": "...", ' +
    '"modules": [{"title": "...", "lessons": [{"title": "...", "summary": ' +
    '"one sentence"}]}]}.';

  const userText =
    `Course name: ${courseName || '(infer from syllabus)'}\n\n` +
    `Syllabus:\n${syllabusText.slice(0, 12000)}`;

  const text = await callClaude(settings.anthropicApiKey, system, userText, 3000, '{');
  return extractJson(text);
}

// Write the full teaching content for one lesson.
async function teachLesson(settings, courseTitle, moduleTitle, lesson) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  const system =
    'You are a patient tutor for college students. Teach the requested lesson ' +
    'from scratch: start with why it matters, explain the core concepts with ' +
    'concrete examples, and end with 2-3 practice questions (with answers at ' +
    'the very end). Use plain text with clear section headings and short ' +
    'paragraphs. Aim for a focused 10-minute read, not a textbook chapter.';

  const userText =
    `Course: ${courseTitle}\nModule: ${moduleTitle}\n` +
    `Lesson: ${lesson.title}\nLesson summary: ${lesson.summary || ''}`;

  return callClaude(settings.anthropicApiKey, system, userText, 4000);
}

// Write a 5-question quiz for a lesson the student has read.
async function quizForLesson(settings, courseTitle, moduleTitle, lesson) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  const system =
    'You write short quizzes for college students. Produce exactly 5 ' +
    'questions testing the core ideas of the lesson — mix recall and ' +
    'application, hardest last. Respond with ONLY a JSON array: ' +
    '[{"q": "...", "a": "concise answer, 1-3 sentences"}].';

  const userText =
    `Course: ${courseTitle}\nModule: ${moduleTitle}\nLesson: ${lesson.title}\n` +
    `Summary: ${lesson.summary || ''}\n\n` +
    `Lesson content:\n${(lesson.content || '(not written yet — quiz from the title and summary)').slice(0, 6000)}`;

  const text = await callClaude(settings.anthropicApiKey, system, userText, 1500, '[');
  return extractJson(text);
}

// ── Company news via Google News RSS ─────────────────────────────────────────
// Free and keyless — replaces the SerpAPI google_news engine entirely.

function decodeXml(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .trim();
}

async function fetchNewsRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Google News RSS error ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map(m => {
    const block = m[1];
    const tag = t => decodeXml((block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
    // Google News titles end with " - Source Name".
    const title = tag('title');
    return {
      title: title.replace(/\s+-\s+[^-]+$/, ''),
      link: tag('link'),
      source: tag('source') || (title.match(/\s+-\s+([^-]+)$/) || [])[1] || '',
      date: (tag('pubDate') || '').replace(/\s+\d{2}:\d{2}:\d{2}.*$/, ''),
    };
  }).filter(n => n.title && n.link);
}

// ── SEC EDGAR ─────────────────────────────────────────────────────────────────
// Free, keyless filings for public companies — 10-Ks and 8-Ks are the best
// prep material for finance interviews. The SEC requires a descriptive
// User-Agent with a contact address on every request.

let edgarTickersCache = null;

async function edgarLookup(companyName, ua) {
  if (!edgarTickersCache) {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`EDGAR tickers error ${res.status}`);
    edgarTickersCache = Object.values(await res.json());
  }
  const q = companyName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 3) return null;
  const hits = edgarTickersCache.filter(t => t.title.toLowerCase().includes(q));
  // Shortest matching title is usually the parent company, not a trust or ETF.
  hits.sort((a, b) => a.title.length - b.title.length);
  return hits[0] || null;
}

async function fetchEdgarFilings(companyName, contactEmail) {
  const ua = `NetworkingHub/1.0 (personal research app; ${contactEmail || 'no-contact-set'})`;
  const hit = await edgarLookup(companyName, ua);
  if (!hit) return null;

  const cik = String(hit.cik_str).padStart(10, '0');
  const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': ua }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`EDGAR submissions error ${res.status}`);
  const data = await res.json();

  const r = data.filings?.recent || {};
  const filings = [];
  for (let i = 0; i < (r.form || []).length && filings.length < 8; i++) {
    if (!['10-K', '10-Q', '8-K'].includes(r.form[i])) continue;
    const accession = (r.accessionNumber?.[i] || '').replace(/-/g, '');
    if (!accession || !r.primaryDocument?.[i]) continue;
    filings.push({
      form: r.form[i],
      date: r.filingDate?.[i] || '',
      title: r.primaryDocDescription?.[i] || r.form[i],
      url: `https://www.sec.gov/Archives/edgar/data/${Number(hit.cik_str)}/${accession}/${r.primaryDocument[i]}`,
    });
  }
  return filings.length ? { name: data.name || companyName, ticker: hit.ticker, filings } : null;
}

// ── Company deep-dive ─────────────────────────────────────────────────────────
// News (free RSS) + SEC filings (free EDGAR) + open-web context, synthesized
// by Claude into a brief. Web context comes from SerpAPI when a key is set;
// otherwise Claude researches the web itself via the built-in search tool.

async function researchCompany(settings, companyName, contactEmail = '') {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  const [news, edgar, web] = await Promise.all([
    fetchNewsRss(`"${companyName}"`).catch(() => []),
    fetchEdgarFilings(companyName, contactEmail).catch(() => null),
    settings.serpApiKey
      ? searchWeb(settings.serpApiKey, `${companyName} company initiatives OR partnership OR product launch`)
          .catch(e => `(search failed: ${e.message})`)
      : Promise.resolve(''),
  ]);

  const system =
    'You brief a college student before they apply or reach out to a company. ' +
    'Write: (1) What the company does, in two sentences. (2) Recent moves — ' +
    'initiatives, deals, launches, funding — as a short bullet list, each ' +
    'grounded in a source. (3) If SEC filings are listed, one bullet on what ' +
    'the latest filings signal (segments, deals, risks worth mentioning in a ' +
    'finance interview). (4) Two talking points the student could use in an ' +
    'outreach email or interview. Plain text, clear headings. Only state ' +
    'things supported by the provided results' +
    ' or by your own web searches.';

  const userText =
    `Company: ${companyName}\n\n` +
    `News results:\n${news.map(n => `- ${n.title} (${n.source}, ${n.date}) ${n.link}`).join('\n') || '(none)'}\n\n` +
    `SEC filings (EDGAR):\n${edgar
      ? edgar.filings.map(f => `- ${f.form} filed ${f.date}: ${f.title} ${f.url}`).join('\n')
      : '(none found — likely private)'}\n\n` +
    `Web results:\n${web || '(none — search the web yourself for recent initiatives, deals, and launches)'}`;

  // Without SerpAPI, give Claude up to 3 of its own web searches.
  const brief = await callClaude(settings.anthropicApiKey, system, userText, 2000, '',
    settings.serpApiKey ? 0 : 3);
  return { brief, news, filings: edgar?.filings || [], ticker: edgar?.ticker || null };
}

// Find *possible* connections at a company: public profiles sharing the
// student's school or past organizations. These are unverified leads, not
// actual LinkedIn connections — the UI must present them as such.
async function findConnectionLeads(settings, profile, companyName) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  // Pull affiliations (schools, employers, clubs) out of the resume.
  const extractSystem =
    'Extract the schools, employers, and organizations from this resume. ' +
    'Respond with ONLY a JSON array of strings, most distinctive first, max 5.';
  const affiliationsText = await callClaude(
    settings.anthropicApiKey, extractSystem,
    profile.resumeText || `${profile.school || ''} ${profile.major || ''}`, 500, '[');
  let affiliations = [];
  try { affiliations = extractJson(affiliationsText).slice(0, 3); } catch { /* fall through */ }
  if (affiliations.length === 0 && profile.school) affiliations = [profile.school];
  if (affiliations.length === 0) return { leads: [], note: 'Add your school or resume to your profile first.' };

  const system =
    'You identify possible warm-connection leads from search results of public ' +
    'LinkedIn profiles. For each plausible person, output name, their role if ' +
    'visible, the shared affiliation, and the profile URL. Respond with ONLY a ' +
    'JSON array: [{"name": "...", "role": "...", "sharedWith": "...", "url": ' +
    '"..."}]. Only include real people from the results; empty array if none.';

  let text;
  if (settings.serpApiKey) {
    const searches = await Promise.all(affiliations.map(a =>
      searchWeb(settings.serpApiKey, `site:linkedin.com/in "${companyName}" "${a}"`).catch(() => '')));
    text = await callClaude(settings.anthropicApiKey, system,
      `Company: ${companyName}\nStudent affiliations: ${affiliations.join(', ')}\n\n` +
      `Search results:\n${searches.filter(Boolean).join('\n') || '(none)'}`, 1500, '[');
  } else {
    // No SerpAPI — Claude runs the people searches itself.
    text = await callClaude(settings.anthropicApiKey, system,
      `Company: ${companyName}\nStudent affiliations: ${affiliations.join(', ')}\n\n` +
      `Search the web (e.g. site:linkedin.com/in queries) for public profiles of people at ` +
      `${companyName} who share one of these affiliations.`, 1500, '[', 4);
  }
  let leads = [];
  try { leads = extractJson(text); } catch { /* none found */ }
  return { leads, note: null };
}

// ── Contact recommendations ───────────────────────────────────────────────────
// Suggests specific people worth a cold outreach across the student's
// best-fit companies: shared-school alumni, people in target roles, campus
// recruiters. Two AI passes around a handful of SerpAPI people searches —
// plan the queries, then rank what came back. Results are public-web leads,
// not confirmed connections; the UI must label them unverified.

async function recommendContacts(settings, profile, opportunities, contacts) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  // Target the companies behind the strongest-fit active postings.
  const targetCompanies = [...new Set(
    opportunities
      .filter(o => o.status === 'new' || o.status === 'saved')
      .sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
      .map(o => o.company)
      .filter(Boolean)
  )].slice(0, 8);

  const known = Object.values(contacts).map(c => c.name).filter(Boolean);

  const rankSystem =
    'You turn web search results of public LinkedIn profiles into outreach ' +
    'suggestions for a college student. Keep only real individual people — ' +
    'no company pages, job listings, or directories. Skip anyone in the ' +
    '"already known" list. For each person give the connection angle, why ' +
    'they are worth contacting, and a one-line personalized opener idea. ' +
    'Respond with ONLY a JSON array, best prospects first, max 10: ' +
    '[{"name": "...", "title": "...", "company": "...", "url": "...", ' +
    '"angle": "...", "reason": "one sentence", "opener": "one line"}]. ' +
    'Empty array if nothing usable.';

  const studentContext =
    `Student:\n${profileSummary(profile) || '(empty)'}\n\n` +
    `Target companies (best match first): ${targetCompanies.join(', ') || '(none yet)'}\n\n` +
    `Already known: ${known.join(', ') || '(none)'}`;

  // Without SerpAPI, Claude plans and runs its own people searches in one call.
  if (!settings.serpApiKey) {
    const text = await callClaude(settings.anthropicApiKey, rankSystem,
      `${studentContext}\n\nSearch the web (site:linkedin.com/in queries work well) for ` +
      'people worth a cold outreach: shared-school alumni at the target companies, ' +
      'people in the student\'s target roles, and university recruiters.',
      2500, '[', 5);
    try { return extractJson(text); } catch { return []; }
  }

  const planSystem =
    'You plan people searches for a college student building a professional ' +
    'network. Given their profile and target companies, produce up to 4 ' +
    'Google queries that will surface public LinkedIn profiles worth a cold ' +
    'outreach: shared-school alumni at target companies, people in the ' +
    'student\'s target roles, university recruiters. Every query must ' +
    'include site:linkedin.com/in. Respond with ONLY a JSON array: ' +
    '[{"q": "...", "angle": "short label, e.g. Union College alumni at Ramp"}].';

  const planText = await callClaude(
    settings.anthropicApiKey, planSystem,
    `Student profile:\n${profileSummary(profile) || '(empty)'}\n\n` +
    `Target companies (best match first): ${targetCompanies.join(', ') || '(none yet — use the profile alone)'}`,
    800, '[');
  const plans = extractJson(planText).slice(0, 4);
  if (plans.length === 0) return [];

  // Each search spends one SerpAPI credit; the plan is capped at 4.
  const results = await Promise.all(plans.map(async p => ({
    angle: p.angle || '',
    hits: await searchWeb(settings.serpApiKey, p.q).catch(() => ''),
  })));

  const rankText = await callClaude(
    settings.anthropicApiKey, rankSystem,
    `${studentContext}\n\n` +
    results.map(r => `Search angle: ${r.angle}\n${r.hits || '(no results)'}`).join('\n\n'),
    2500, '[');
  try { return extractJson(rankText); } catch { return []; }
}

// ── Resume feedback ───────────────────────────────────────────────────────────

async function resumeFeedback(settings, profile) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');
  if (!profile.resumeText) throw new Error('No resume yet. Paste or import one first.');

  const system =
    'You are a career-center resume reviewer for college students. Review the ' +
    'resume against the student\'s stated goals and interests. Give: (1) top ' +
    'three strengths, (2) top three specific fixes ranked by impact, each with ' +
    'a rewritten example line, (3) missing elements recruiters expect for ' +
    'their target roles, (4) a one-line overall verdict. Be direct and ' +
    'concrete; no generic advice.';

  const userText =
    `Goals: ${profile.goals || '(unspecified)'}\n` +
    `Interests: ${(profile.interests || []).join(', ') || '(unspecified)'}\n` +
    `Grad year: ${profile.gradYear || '?'}\n\nResume:\n${profile.resumeText.slice(0, 8000)}`;

  return callClaude(settings.anthropicApiKey, system, userText, 2500);
}

// ── Web presence scan ─────────────────────────────────────────────────────────
// Searches the open web for mentions of the student: articles, public
// profiles, project pages.

async function scanWebForMe(settings, profile) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');
  if (!profile.name) throw new Error('Add your name to your profile first.');

  const system =
    'You filter web search results to find mentions of a specific student. ' +
    'Given their profile, keep only results plausibly about THEM (not ' +
    'namesakes) — check school, location, field. Respond with ONLY a JSON ' +
    'array: [{"title": "...", "url": "...", "why": "one sentence on why this ' +
    'looks like them and what it is"}]. Empty array if nothing matches.';

  const who =
    `Student: ${profile.name}, ${profile.school || ''} ${profile.major || ''}, ` +
    `${profile.location || ''}\nGitHub: ${profile.github || '?'}`;

  let text;
  if (settings.serpApiKey) {
    const queries = [
      `"${profile.name}" ${profile.school || ''}`.trim(),
      `"${profile.name}" ${(profile.interests || [])[0] || profile.major || ''}`.trim(),
    ];
    const results = await Promise.all(queries.map(q =>
      searchWeb(settings.serpApiKey, q).catch(() => '')));
    text = await callClaude(settings.anthropicApiKey, system,
      `${who}\n\nSearch results:\n${results.filter(Boolean).join('\n') || '(none)'}`, 1500, '[');
  } else {
    // No SerpAPI — Claude searches for the student itself.
    text = await callClaude(settings.anthropicApiKey, system,
      `${who}\n\nSearch the web for pages that mention this student: articles, ` +
      'public profiles, project pages, competition results.', 1500, '[', 3);
  }
  try { return extractJson(text); } catch { return []; }
}

// ── Opening forecast ──────────────────────────────────────────────────────────
// Predicts what roles are likely to open soon, combining the observed posting
// history in the user's feed with known recruiting-cycle timing (tech
// internships, IB summer analyst programs, PE on-cycle, etc.).

async function forecastOpenings(settings, profile, opportunities) {
  if (!settings.anthropicApiKey) throw new MissingKeyError('Anthropic');

  // Compress the feed: one line per company with its roles and when seen.
  const byCompany = new Map();
  for (const o of opportunities) {
    if (!o.company) continue;
    const key = o.company.toLowerCase();
    if (!byCompany.has(key)) byCompany.set(key, { name: o.company, roles: new Set(), dates: [] });
    const rec = byCompany.get(key);
    rec.roles.add((o.title || '').slice(0, 60));
    rec.dates.push((o.postedAt || o.createdAt || '').slice(0, 10));
  }
  const feedLines = [...byCompany.values()].slice(0, 80).map(c =>
    `${c.name}: ${[...c.roles].slice(0, 5).join('; ')} (seen: ${c.dates.filter(Boolean).slice(0, 3).join(', ')})`);

  const system =
    'You forecast upcoming job and internship openings for a college student. ' +
    'Combine two signals: (1) patterns in the posting history provided — which ' +
    'companies hire for which roles and when; (2) well-known recruiting ' +
    'cycles (software internships open Aug-Oct for the following summer, ' +
    'investment banking summer analyst programs recruit ~18 months ahead, PE ' +
    'on-cycle recruiting, fellowship deadlines, etc.). Respond with ONLY JSON: ' +
    '{"summary": "2-3 sentence overview of where the student is in the ' +
    'recruiting calendar right now", "predictions": [{"title": "role or ' +
    'program", "companies": ["..."], "window": "when applications likely ' +
    'open, e.g. Aug-Sep 2026", "likelihood": "high|medium|low", "rationale": ' +
    '"one sentence grounded in the data or a known cycle", "action": "one ' +
    'concrete thing to do now"}]}. 6-8 predictions, most relevant first, ' +
    'tailored to the student\'s profile and graduation year.';

  const userText =
    `Today: ${new Date().toDateString()}\n\n` +
    `Student:\n${profileSummary(profile) || '(empty profile)'}\n\n` +
    `Posting history from their feed:\n${feedLines.join('\n') || '(feed is empty — rely on known recruiting cycles)'}`;

  const text = await callClaude(settings.anthropicApiKey, system, userText, 3000, '{');
  return extractJson(text);
}

module.exports = {
  researchContact, draftEmail,
  matchOpportunities, courseForRole, courseFromSyllabus, teachLesson, quizForLesson,
  researchCompany, findConnectionLeads, recommendContacts, resumeFeedback, scanWebForMe,
  forecastOpenings, extractPostingsFromPage,
};
