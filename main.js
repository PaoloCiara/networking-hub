'use strict';

const { app, BrowserWindow, ipcMain, Notification, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const jobs = require('./services/jobs');
const ai = require('./services/ai');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'Networking Hub',
    titleBarStyle: 'hiddenInset', // traffic lights float over the sidebar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // External links open in the default browser, never inside the app window —
  // and only real web links. Untrusted job/AI data must never be able to hand
  // a javascript:, file:, or custom-protocol URL to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The app only ever renders its own local file. Block any attempt to
  // navigate the main frame elsewhere (e.g. injected window.location); send
  // genuine web links to the browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

// ── Follow-up checker ─────────────────────────────────────────────────────────
// Runs at launch and every 6 hours: contacts still in "emailed" past the
// follow-up window get flipped to "needs_follow_up" and trigger a notification.

function checkFollowUps() {
  const { followUpDays = 14 } = db.getSettings();
  const cutoffMs = followUpDays * 86_400_000;
  const now = Date.now();
  const due = [];

  for (const contact of Object.values(db.getContacts())) {
    if (contact.status !== 'emailed' || !contact.lastEmailedAt) continue;
    if (now - new Date(contact.lastEmailedAt).getTime() >= cutoffMs) {
      db.saveContact({ ...contact, status: 'needs_follow_up' });
      due.push(contact);
    }
  }

  if (due.length > 0 && Notification.isSupported()) {
    new Notification({
      title: `${due.length} contact${due.length > 1 ? 's' : ''} need${due.length > 1 ? '' : 's'} a follow-up`,
      body: due.map(c => c.name || c.email).slice(0, 3).join(', ')
        + (due.length > 3 ? ` and ${due.length - 3} more` : ''),
    }).show();
  }

  if (due.length > 0 && win) win.webContents.send('contacts-changed');
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('contacts:list', () => db.getContacts());
ipcMain.handle('contacts:save', (_e, contact) => db.saveContact(contact));
ipcMain.handle('contacts:delete', (_e, email) => db.deleteContact(email));

ipcMain.handle('opps:list', () => db.getOpportunities());
ipcMain.handle('opps:save', (_e, opp) => db.saveOpportunity(opp));
ipcMain.handle('opps:delete', (_e, id) => db.deleteOpportunity(id));

ipcMain.handle('opps:refresh', async () => {
  const settings = db.getSettings();
  const { opportunities, errors } = await jobs.fetchAllOpportunities(settings);
  // Persist new finds without clobbering statuses on ones already tracked.
  const existing = db.getOpportunities();
  let added = 0;
  for (const opp of opportunities) {
    if (!existing[opp.id]) { db.saveOpportunity(opp); added++; }
  }
  return { added, total: opportunities.length, errors };
});

ipcMain.handle('settings:get', () => db.getSettings());
ipcMain.handle('settings:save', (_e, updates) => db.saveSettings(updates));

ipcMain.handle('profile:get', () => db.getProfile());
ipcMain.handle('profile:save', (_e, updates) => db.saveProfile(updates));

ipcMain.handle('courses:list', () => db.getCourses());
ipcMain.handle('courses:save', (_e, course) => db.saveCourse(course));
ipcMain.handle('courses:delete', (_e, id) => db.deleteCourse(id));

// File picker for resumes and syllabi. Extracts plain text from PDF, TXT, MD.
ipcMain.handle('files:pick-text', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'txt', 'md'] }],
  });
  if (canceled || filePaths.length === 0) return null;

  const filePath = filePaths[0];
  const name = path.basename(filePath);

  if (filePath.toLowerCase().endsWith('.pdf')) {
    // pdf-parse v2 exports a class-based API, not a callable function.
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
    const result = await parser.getText();
    return { name, text: (result.text || '').trim() };
  }
  return { name, text: fs.readFileSync(filePath, 'utf8').trim() };
});

ipcMain.handle('ai:research', async (_e, contact) => {
  return ai.researchContact(db.getSettings(), contact);
});
ipcMain.handle('ai:draft', async (_e, { contact, research, tone }) => {
  return ai.draftEmail(db.getSettings(), contact, research, tone);
});

// Score active opportunities against the profile and persist the results.
// Only unscored postings are sent — already-scored ones keep their result,
// which keeps repeat clicks cheap. When everything is scored, one more click
// re-scores the whole feed (useful after a profile update).
ipcMain.handle('ai:match', async () => {
  const settings = db.getSettings();
  const profile = db.getProfile();
  const active = Object.values(db.getOpportunities())
    .filter(o => o.status === 'new' || o.status === 'saved');
  if (active.length === 0) return { matched: 0, rescored: false };

  const unscored = active.filter(o => !Number.isFinite(o.matchScore));
  const rescored = unscored.length === 0;
  const opps = rescored ? active : unscored;

  const scores = await ai.matchOpportunities(settings, profile, opps);
  const byId = Object.fromEntries(scores.map(s => [s.id, s]));
  let matched = 0;
  for (const opp of opps) {
    const s = byId[opp.id];
    if (!s) continue;
    db.saveOpportunity({ ...opp, matchScore: s.score, matchReason: s.reason });
    matched++;
  }
  return { matched, rescored };
});

ipcMain.handle('companies:list', () => db.getCompanies());

ipcMain.handle('forecast:get', () => db.getForecast());
ipcMain.handle('ai:forecast', async () => {
  const data = await ai.forecastOpenings(
    db.getSettings(), db.getProfile(), Object.values(db.getOpportunities()));
  return db.saveForecast(data);
});

ipcMain.handle('ai:company-research', async (_e, companyName) => {
  // Profile email doubles as the SEC EDGAR contact address (they require one).
  const { brief, news, filings, ticker } = await ai.researchCompany(
    db.getSettings(), companyName, db.getProfile().email);
  return db.saveCompany({ name: companyName, brief, news, filings, ticker, researchedAt: new Date().toISOString() });
});

ipcMain.handle('ai:company-leads', async (_e, companyName) => {
  const { leads, note } = await ai.findConnectionLeads(db.getSettings(), db.getProfile(), companyName);
  if (!note) db.saveCompany({ name: companyName, leads, leadsAt: new Date().toISOString() });
  return { leads, note };
});

ipcMain.handle('chats:list', () => db.getChats());
ipcMain.handle('chats:save', (_e, chat) => db.saveChat(chat));
ipcMain.handle('chats:delete', (_e, id) => db.deleteChat(id));

ipcMain.handle('contacts:suggestions', () => db.getContactSuggestions());
ipcMain.handle('contacts:suggestions-save', (_e, record) => db.saveContactSuggestions(record));

ipcMain.handle('ai:recommend-contacts', async () => {
  // New finds append to the existing list — suggestions only leave the list
  // when the user dismisses them or adds them as contacts.
  const prior = db.getContactSuggestions()?.items || [];
  const fresh = await ai.recommendContacts(
    db.getSettings(), db.getProfile(),
    Object.values(db.getOpportunities()), db.getContacts(), prior);

  const seen = new Set(prior.map(s => (s.url || s.name || '').toLowerCase()));
  const merged = [...prior];
  for (const s of fresh) {
    const key = (s.url || s.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }
  return db.saveContactSuggestions({
    items: merged.slice(0, 40),
    generatedAt: new Date().toISOString(),
    added: merged.length - prior.length,
  });
});

ipcMain.handle('ai:resume-feedback', async () => {
  return ai.resumeFeedback(db.getSettings(), db.getProfile());
});

// In-app assistant: context comes from whatever the user is looking at.
ipcMain.handle('ai:chat', async (_e, { context, messages }) => {
  return ai.chatAssistant(db.getSettings(), context, messages);
});

// Read the resume and add fitting titles/companies/sectors to jobKeywords.
ipcMain.handle('ai:suggest-keywords', async () => {
  const settings = db.getSettings();
  const existing = settings.jobKeywords || [];
  const fresh = await ai.suggestKeywords(settings, db.getProfile(), existing);

  const have = new Set(existing.map(k => k.toLowerCase()));
  const merged = [...existing];
  for (const k of fresh) {
    const key = k.toLowerCase().trim();
    if (!key || have.has(key)) continue;
    have.add(key);
    merged.push(key);
  }
  db.saveSettings({ jobKeywords: merged.slice(0, 20) });
  return { added: merged.length - existing.length, keywords: merged };
});

ipcMain.handle('ai:cover-letter', async (_e, { jobText, notes }) => {
  return ai.coverLetter(db.getSettings(), db.getProfile(), jobText, notes);
});

ipcMain.handle('ai:course-projects', async (_e, courseId) => {
  const course = db.getCourses()[courseId];
  if (!course) throw new Error('Course not found.');
  course.projects = await ai.projectsForCourse(db.getSettings(), db.getProfile(), course);
  return db.saveCourse(course);
});

ipcMain.handle('ai:course-role', async (_e, role) => {
  const outline = await ai.courseForRole(db.getSettings(), db.getProfile(), role);
  return saveOutlineAsCourse(outline, 'role', role);
});

ipcMain.handle('ai:course-syllabus', async (_e, { text, name }) => {
  const outline = await ai.courseFromSyllabus(db.getSettings(), text, name);
  return saveOutlineAsCourse(outline, 'syllabus', name);
});

ipcMain.handle('ai:lesson', async (_e, { courseId, moduleIdx, lessonIdx }) => {
  const course = db.getCourses()[courseId];
  if (!course) throw new Error('Course not found.');
  const mod = course.modules[moduleIdx];
  const lesson = mod.lessons[lessonIdx];
  const content = await ai.teachLesson(db.getSettings(), course.title, mod.title, lesson);
  lesson.content = content;
  db.saveCourse(course);
  return content;
});

// Write every lesson in one module with a single AI call. `force` rewrites
// lessons that already have content (used for whole-course regeneration).
ipcMain.handle('ai:write-module', async (_e, { courseId, moduleIdx, force }) => {
  const course = db.getCourses()[courseId];
  if (!course) throw new Error('Course not found.');
  const mod = course.modules[moduleIdx];
  const targets = mod.lessons.filter(l => force || !l.content);
  if (targets.length === 0) return { written: 0, total: 0 };

  const contents = await ai.writeModuleLessons(db.getSettings(), course.title, mod.title, targets);
  let written = 0;
  targets.forEach((lesson, i) => {
    if (contents[i]) { lesson.content = contents[i]; written++; }
  });
  if (written === 0) throw new Error('Module generation returned no lessons.');
  db.saveCourse(course);
  return { written, total: targets.length };
});

ipcMain.handle('ai:quiz', async (_e, { courseId, moduleIdx, lessonIdx }) => {
  const course = db.getCourses()[courseId];
  if (!course) throw new Error('Course not found.');
  const mod = course.modules[moduleIdx];
  const lesson = mod.lessons[lessonIdx];
  const quiz = await ai.quizForLesson(db.getSettings(), course.title, mod.title, lesson);
  lesson.quiz = quiz;
  db.saveCourse(course);
  return quiz;
});

// Normalize an AI outline into a stored course record.
function saveOutlineAsCourse(outline, source, label) {
  const course = {
    id: `course-${Date.now()}`,
    title: outline.title || label || 'Untitled course',
    source,
    roleFor: source === 'role' ? label : null,  // ties the course back to job postings
    projects: outline.projects || [],           // hands-on, resume-worthy builds
    modules: (outline.modules || []).map(m => ({
      title: m.title,
      lessons: (m.lessons || []).map(l => ({
        title: l.title,
        summary: l.summary || '',
        content: null,
        done: false,
      })),
    })),
  };
  return db.saveCourse(course);
}

ipcMain.handle('open-external', (_e, url) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ── Auto-refresh ──────────────────────────────────────────────────────────────
// While the app is open: pull fresh opportunities every 4 hours, score any
// new ones against the profile (if an Anthropic key is set), and notify when
// strong fits show up.

async function autoRefreshOpportunities() {
  try {
    const settings = db.getSettings();
    const { opportunities } = await jobs.fetchAllOpportunities(settings);
    const existing = db.getOpportunities();
    const fresh = opportunities.filter(o => !existing[o.id]);
    if (fresh.length === 0) return;

    for (const opp of fresh) db.saveOpportunity(opp);

    let strongFits = 0;
    if (settings.anthropicApiKey) {
      const scores = await ai.matchOpportunities(settings, db.getProfile(), fresh)
        .catch(() => []);
      for (const s of scores) {
        const opp = db.getOpportunities()[s.id];
        if (!opp) continue;
        db.saveOpportunity({ ...opp, matchScore: s.score, matchReason: s.reason });
        if (s.score >= 70) strongFits++;
      }
    }

    if (Notification.isSupported()) {
      new Notification({
        title: `${fresh.length} new opportunit${fresh.length === 1 ? 'y' : 'ies'} found`,
        body: strongFits > 0
          ? `${strongFits} look like a strong fit for your profile.`
          : 'Open the Opportunities tab to review them.',
      }).show();
    }
    if (win) win.webContents.send('contacts-changed');
  } catch (err) {
    console.error('[auto-refresh]', err.message);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  checkFollowUps();
  setInterval(checkFollowUps, 6 * 60 * 60 * 1000);
  setTimeout(autoRefreshOpportunities, 30 * 1000); // first pass shortly after launch
  setInterval(autoRefreshOpportunities, 4 * 60 * 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
