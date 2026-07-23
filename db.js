'use strict';

// Single-file JSON store kept in Electron's per-user data directory
// (~/Library/Application Support/Networking Hub/data.json on macOS — the
// folder is named after package.json's productName).
// All reads/writes go through this module so the shape stays consistent.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  contacts: {},        // keyed by email
  opportunities: {},   // keyed by id
  courses: {},         // keyed by id — AI-generated curricula and imported syllabi
  companies: {},       // keyed by normalized name — cached research and leads
  forecast: null,      // last AI prediction of upcoming openings
  contactSuggestions: null, // last AI-recommended people to reach out to
  chats: {},           // saved assistant conversations, keyed by id
  profile: {
    name: '', email: '', phone: '', location: '',
    school: '', major: '', gradYear: '',
    github: '', linkedin: '', portfolio: '',
    interests: [],     // drives job matching and course generation
    goals: '',
    resumeText: '',
  },
  settings: {
    anthropicApiKey: '',
    serpApiKey: '',
    followUpDays: 14,
    // Company slugs used for ATS board lookups. Editable in Settings.
    // Roster leans SWE-internship + fintech/quant; all verified to return jobs.
    greenhouseBoards: [
      'stripe', 'anthropic', 'airbnb', 'figma', 'databricks',
      'affirm', 'akunacapital', 'brex', 'chime', 'cloudflare', 'coinbase',
      'datadog', 'discord', 'doordashusa', 'drweng', 'imc', 'janestreet',
      'jumptrading', 'marqeta', 'mongodb', 'optiverus', 'point72', 'reddit',
      'robinhood', 'roblox', 'sofi', 'scaleai',
    ],
    // 'ramp' moved to Ashby, 'scaleai' to Greenhouse — Lever slug now just Plaid.
    leverBoards: ['plaid'],
    ashbyBoards: ['ramp', 'linear', 'notion', 'snowflake', 'vanta'],
    smartrecruitersBoards: [],
    workableBoards: [],
    // Workday employers as "tenant:datacenter:site" (public CXS API, no key).
    workdayBoards: [
      'blackrock:wd1:BlackRock_Professional',
      'nvidia:wd5:NVIDIAExternalCareerSite',
      'capitalone:wd12:Capital_One',
      'mastercard:wd1:CorporateCareers',
    ],
    careersPages: [],        // arbitrary careers-page URLs, AI-extracted
    usaJobsEmail: '',        // optional, free — developer.usajobs.gov
    usaJobsKey: '',
    adzunaAppId: '',         // optional, free — developer.adzuna.com
    adzunaAppKey: '',
    youtubeApiKey: '',       // optional — direct video links in Learn lessons
    jobKeywords: ['software engineer'],
    jobLocation: '',         // preferred area passed to Google Jobs searches
    hideSeniorRoles: true,   // college students don't need staff/principal listings
  },
};

let cache = null;

function dbPath() {
  return path.join(app.getPath('userData'), 'data.json');
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(dbPath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      ...DEFAULTS,
      ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      profile:  { ...DEFAULTS.profile,  ...(parsed.profile  || {}) },
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
  fs.writeFileSync(dbPath(), JSON.stringify(cache, null, 2), 'utf8');
}

// ── Contacts ──────────────────────────────────────────────────────────────────

function getContacts() {
  return load().contacts;
}

function saveContact(contact) {
  if (!contact || !contact.email) throw new Error('Contact requires an email.');
  const db = load();
  const now = new Date().toISOString();
  const existing = db.contacts[contact.email] || {};
  db.contacts[contact.email] = {
    ...existing,
    ...contact,
    updatedAt: now,
    createdAt: existing.createdAt || now,
  };
  save();
  return db.contacts[contact.email];
}

function deleteContact(email) {
  const db = load();
  delete db.contacts[email];
  save();
}

// ── Opportunities ─────────────────────────────────────────────────────────────

function getOpportunities() {
  return load().opportunities;
}

function saveOpportunity(opp) {
  if (!opp || !opp.id) throw new Error('Opportunity requires an id.');
  const db = load();
  const now = new Date().toISOString();
  const existing = db.opportunities[opp.id] || {};
  db.opportunities[opp.id] = {
    status: 'new', // new | saved | applied | dismissed
    ...existing,
    ...opp,
    updatedAt: now,
    createdAt: existing.createdAt || now,
  };
  save();
  return db.opportunities[opp.id];
}

function deleteOpportunity(id) {
  const db = load();
  delete db.opportunities[id];
  save();
}

// ── Profile ───────────────────────────────────────────────────────────────────

function getProfile() {
  return load().profile;
}

function saveProfile(updates) {
  const db = load();
  db.profile = { ...db.profile, ...updates };
  save();
  return db.profile;
}

// ── Courses ───────────────────────────────────────────────────────────────────

function getCourses() {
  return load().courses;
}

function saveCourse(course) {
  if (!course || !course.id) throw new Error('Course requires an id.');
  const db = load();
  const now = new Date().toISOString();
  const existing = db.courses[course.id] || {};
  db.courses[course.id] = {
    ...existing,
    ...course,
    updatedAt: now,
    createdAt: existing.createdAt || now,
  };
  save();
  return db.courses[course.id];
}

function deleteCourse(id) {
  const db = load();
  delete db.courses[id];
  save();
}

// ── Companies ─────────────────────────────────────────────────────────────────

function companyKey(name) {
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
}

function getCompanies() {
  return load().companies;
}

function saveCompany(company) {
  if (!company || !company.name) throw new Error('Company requires a name.');
  const db = load();
  const key = companyKey(company.name);
  const now = new Date().toISOString();
  const existing = db.companies[key] || {};
  db.companies[key] = {
    ...existing,
    ...company,
    key,
    updatedAt: now,
    createdAt: existing.createdAt || now,
  };
  save();
  return db.companies[key];
}

// ── Saved assistant chats ─────────────────────────────────────────────────────

function getChats() {
  return load().chats;
}

function saveChat(chat) {
  if (!chat || !chat.id) throw new Error('Chat requires an id.');
  const db = load();
  const existing = db.chats[chat.id] || {};
  db.chats[chat.id] = {
    ...existing,
    ...chat,
    updatedAt: new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
  };
  save();
  return db.chats[chat.id];
}

function deleteChat(id) {
  const db = load();
  delete db.chats[id];
  save();
}

// ── Contact suggestions ───────────────────────────────────────────────────────

function getContactSuggestions() {
  return load().contactSuggestions;
}

function saveContactSuggestions(record) {
  const db = load();
  db.contactSuggestions = record;
  save();
  return record;
}

// ── Forecast ──────────────────────────────────────────────────────────────────

function getForecast() {
  return load().forecast;
}

function saveForecast(forecast) {
  const db = load();
  db.forecast = { ...forecast, generatedAt: new Date().toISOString() };
  save();
  return db.forecast;
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
  return load().settings;
}

function saveSettings(updates) {
  const db = load();
  db.settings = { ...db.settings, ...updates };
  save();
  return db.settings;
}

module.exports = {
  getContacts, saveContact, deleteContact,
  getOpportunities, saveOpportunity, deleteOpportunity,
  getProfile, saveProfile,
  getCourses, saveCourse, deleteCourse,
  getCompanies, saveCompany, companyKey,
  getForecast, saveForecast,
  getContactSuggestions, saveContactSuggestions,
  getChats, saveChat, deleteChat,
  getSettings, saveSettings,
};
