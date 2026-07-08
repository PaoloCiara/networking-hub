'use strict';

// Renderer logic. All data access goes through window.api (see preload.js).

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const STATUS_LABELS = {
  emailed: 'Emailed', replied: 'Replied',
  needs_follow_up: 'Needs Follow-up', archived: 'Archived',
  new: 'New', saved: 'Saved', applied: 'Applied', dismissed: 'Dismissed',
};

const PALETTE = ['#1a73e8','#188038','#d93025','#e37400','#8430ce','#007b83','#c5221f','#0d652d'];
const avatarColor = s => { let h = 0; for (const c of s || '?') h = c.charCodeAt(0) + ((h << 5) - h); return PALETTE[Math.abs(h) % PALETTE.length]; };
const initials = n => (n || '?').trim().split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase();
const timeAgo = iso => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso)) / 86_400_000);
  return d === 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d}d ago`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const decodeEntities = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };
// Toggle a button's loading spinner (see .btn.busy in styles.css).
const busy = (btn, on) => { btn.disabled = on; btn.classList.toggle('busy', on); };

// ── Markdown rendering ────────────────────────────────────────────────────────
// AI content (lessons, briefs, feedback) arrives as Markdown. Render the
// common subset — headings, bold/italic/code, lists, fenced blocks — into
// HTML instead of showing raw ## markers. All text passes through esc()
// first, so model output can't inject markup.
function mdToHtml(md) {
  let html = '';
  let inList = false;
  let inCode = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const inline = s => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  for (const line of (md || '').split('\n')) {
    if (/^\s*```/.test(line)) {
      closeList();
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      closeList();
      const lvl = Math.min(heading[1].length + 2, 6); // # → h3 … #### → h6
      html += `<h${lvl}>${inline(heading[2].replace(/#+\s*$/, ''))}</h${lvl}>`;
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(bullet[1])}</li>`;
      continue;
    }
    if (line.trim() === '') { closeList(); continue; }
    closeList();
    const hr = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    html += hr ? '<hr>' : `<p>${inline(line)}</p>`;
  }
  closeList();
  if (inCode) html += '</code></pre>';
  return html;
}

// ── Title casing ──────────────────────────────────────────────────────────────
// Postings arrive in every style ("SOFTWARE ENGINEER", "analyst, private
// credit"). Normalize for display while preserving acronyms and names that
// already carry intentional capitalization (iOS, McKinsey).
const ACRONYMS = new Set([
  'ai', 'ml', 'ui', 'ux', 'qa', 'api', 'sre', 'swe', 'sde', 'it', 'hr',
  'ib', 'pe', 'vc', 'etf', 'fpga', 'llm', 'nyc', 'ny', 'us', 'usa', 'uk',
  'vp', 'ceo', 'cto', 'cfo', 'ii', 'iii', 'iv',
]);
const SMALL_WORDS = new Set(['of', 'and', 'the', 'for', 'at', 'in', 'to', 'on', 'a', 'an', 'or', 'with']);

function titleCase(s) {
  return (s || '').split(' ').map((w, i) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ACRONYMS.has(bare)) return w.toUpperCase();
    if (i > 0 && SMALL_WORDS.has(bare)) return w.toLowerCase();
    if (/[A-Z]/.test(w.slice(1))) return w; // already intentionally cased
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

// ── Job level classification ─────────────────────────────────────────────────
// Derived from the title at render time so it also applies to postings
// fetched before this feature existed.
function classifyLevel(title) {
  const t = (title || '').toLowerCase();
  if (/\bintern(ship)?\b|\bco-?op\b/.test(t)) return 'internship';
  if (/\bfellow(ship)?\b/.test(t)) return 'fellowship';
  if (/senior|staff|principal|\blead\b|manager|director|\bvp\b|head of|chief|\bsr\.?\b/.test(t)) return 'senior';
  if (/new grad|entry.level|junior|early career|university grad|campus|graduate program/.test(t)) return 'entry';
  return 'fulltime';
}

// ── Company logos ─────────────────────────────────────────────────────────────
// Google's favicon service is free and keyless. We guess the domain from the
// company name; when Google has no real icon it returns a tiny placeholder,
// which we detect by size and swap for an initials avatar.
function companyDomainGuess(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[,.]?\s+(inc|llc|ltd|corp|co|gmbh|labs)\.?$/i, '')
    .trim()
    .replace(/[^a-z0-9]/g, '') + '.com';
}

function initialsAvatar(name, size) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.cssText = `width:${size}px;height:${size}px;background:${avatarColor(name)};font-size:${Math.round(size * 0.36)}px`;
  div.textContent = initials(name);
  return div;
}

function logoEl(name, size = 36) {
  const wrap = document.createElement('div');
  wrap.className = 'logo-wrap';
  wrap.style.width = wrap.style.height = `${size}px`;

  const domain = companyDomainGuess(name);
  const img = document.createElement('img');
  img.className = 'logo-img';
  img.alt = '';
  const initialsFallback = () => wrap.replaceChildren(initialsAvatar(name, size));
  // Second choice: Google's favicon service, which returns a 16px generic
  // globe when the domain is unknown — detect that by size.
  const faviconFallback = () => {
    img.onerror = initialsFallback;
    img.onload = () => { if (img.naturalWidth < 32) initialsFallback(); };
    img.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
  };
  // First choice: Clearbit serves real, higher-quality logos and 404s cleanly.
  img.onerror = faviconFallback;
  img.src = `https://logo.clearbit.com/${domain}`;
  wrap.appendChild(img);
  return wrap;
}

let contacts = {};
let opportunities = {};
let courses = {};
let companies = {};
let appSettings = {};
let contactFilter = 'all';
let oppFilter = 'active';
let oppRoleFilter = 'all';
let oppTypeFilter = 'all';
let oppAreaFilter = 'all';
const expandedOpps = new Set(); // opportunity ids with their detail pane open
const OPP_PAGE = 200;           // rows rendered per page in the Opportunities list
let oppShowLimit = OPP_PAGE;
let suggestions = null;     // last AI contact recommendations: { items, generatedAt }
let editingEmail = null;    // null = creating a new contact
let activeCourseId = null;  // course open in the Learn detail pane
let activeCompany = null;   // company name open in the Companies detail pane

// ── Navigation ────────────────────────────────────────────────────────────────

function showView(name) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.hidden = true);
  $(`#view-${name}`).hidden = false;
}

$$('.nav-item').forEach(btn =>
  btn.addEventListener('click', () => { if (btn.dataset.view) showView(btn.dataset.view); }));

// ── Dashboard ─────────────────────────────────────────────────────────────────

function renderDashboard() {
  const all = Object.values(contacts);
  const opps = Object.values(opportunities);
  const active = opps.filter(o => o.status === 'new' || o.status === 'saved');

  $('#d-contacts').textContent  = all.length;
  $('#d-followups').textContent = all.filter(c => c.status === 'needs_follow_up').length;
  $('#d-replied').textContent   = all.filter(c => c.status === 'replied').length;
  $('#d-opps').textContent      = opps.filter(o => o.status !== 'dismissed').length;
  $('#d-fits').textContent      = active.filter(o => (o.matchScore || 0) >= 70).length;
  $('#d-applied').textContent   = opps.filter(o => o.status === 'applied').length;

  // Top matches: the five best-scoring active postings, expandable in place.
  const matches = active
    .filter(o => Number.isFinite(o.matchScore))
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
  $('#d-matches').innerHTML = matches.length === 0
    ? '<div class="empty">Run "Match to my profile" in Opportunities to see your best fits here.</div>'
    : '';
  matches.forEach(o => $('#d-matches').appendChild(oppRow(o)));

  const queue = all
    .filter(c => c.status === 'needs_follow_up')
    .sort((a, b) => new Date(a.lastEmailedAt || 0) - new Date(b.lastEmailedAt || 0));

  $('#d-queue').innerHTML = queue.length === 0
    ? '<div class="empty">Nobody needs a follow-up right now.</div>'
    : '';
  queue.forEach(c => $('#d-queue').appendChild(contactRow(c)));
}

// ── Contacts ──────────────────────────────────────────────────────────────────

function contactRow(c) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="avatar" style="background:${avatarColor(c.name || c.email)}">${esc(initials(c.name))}</div>
    <div class="row-info">
      <div class="row-title">${esc(c.name || c.email)}</div>
      <div class="row-meta">${esc([c.company, c.email].filter(Boolean).join(' · '))} · emailed ${timeAgo(c.lastEmailedAt)}</div>
    </div>
    <span class="badge badge-${esc(c.status || 'archived')}">${esc(STATUS_LABELS[c.status] || c.status || '—')}</span>
  `;
  row.addEventListener('click', () => openContactModal(c.email));
  return row;
}

function renderContacts() {
  const list = $('#contact-list');
  list.innerHTML = '';
  const rows = Object.values(contacts)
    .filter(c => contactFilter === 'all' || c.status === contactFilter)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">No contacts here yet. Click "Add contact" to start tracking someone.</div>';
    return;
  }
  rows.forEach(c => list.appendChild(contactRow(c)));
}

$('#contact-filters').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#contact-filters .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  contactFilter = chip.dataset.f;
  renderContacts();
});

// ── Suggested contacts ────────────────────────────────────────────────────────
// AI-recommended people to reach out to: alumni and target-role folks at the
// user's best-fit companies. Unverified public-web leads — the card links out
// so the user can check the profile before adding it as a real contact.

function suggestionCard(s) {
  const card = document.createElement('div');
  card.className = 'opp-item expanded';
  card.innerHTML = `
    <div class="row" style="cursor:default">
      <div class="avatar" style="background:${avatarColor(s.name)}">${esc(initials(s.name))}</div>
      <div class="row-info">
        <div class="row-title">${esc(s.name || 'Unknown')}</div>
        <div class="row-meta">${esc([s.title, s.company].filter(Boolean).join(' · '))}</div>
      </div>
      <span class="badge badge-saved">${esc(s.angle || 'Lead')}</span>
    </div>
    <div class="opp-detail">
      ${s.reason ? `<div><div class="opp-detail-label">Why this person</div><div class="opp-detail-text">${esc(s.reason)}</div></div>` : ''}
      ${s.opener ? `<div><div class="opp-detail-label">Opener idea</div><div class="opp-detail-text">${esc(s.opener)}</div></div>` : ''}
      <div class="btn-row">
        ${s.url ? '<button class="btn small" data-act="open">Open profile</button>' : ''}
        <button class="btn small" data-act="add">Add to contacts</button>
        <button class="btn small" data-act="dismiss">Dismiss</button>
      </div>
    </div>
  `;
  card.querySelector('[data-act="open"]')?.addEventListener('click', () =>
    window.api.openExternal(s.url));
  card.querySelector('[data-act="add"]').addEventListener('click', () => {
    // Prefill the contact modal; the user supplies the email once they have it.
    openContactModal();
    $('#modal-title').textContent = s.name || 'New Contact';
    $('#m-name').value    = s.name || '';
    $('#m-company').value = s.company || '';
    $('#m-status').value  = 'archived'; // not emailed yet — just tracking the lead
    $('#m-notes').value   = [
      s.title, s.angle && `Connection angle: ${s.angle}`, s.reason, s.url,
    ].filter(Boolean).join('\n');
  });
  card.querySelector('[data-act="dismiss"]').addEventListener('click', async () => {
    suggestions.items = (suggestions.items || []).filter(x => x !== s);
    await window.api.contacts.saveSuggestions(suggestions);
    renderSuggestions();
  });
  return card;
}

function renderSuggestions() {
  const list = $('#suggest-list');
  list.innerHTML = '';
  const items = suggestions?.items || [];
  if (items.length === 0) {
    list.innerHTML = '<div class="empty">No suggestions yet. Match your opportunities first (so the AI knows your target companies), then click "Find people to contact".</div>';
    return;
  }
  if (suggestions.generatedAt) {
    $('#suggest-status').textContent = `Last generated ${timeAgo(suggestions.generatedAt)}`;
  }
  items.forEach(s => list.appendChild(suggestionCard(s)));
}

$('#btn-suggest-contacts').addEventListener('click', async e => {
  busy(e.target, true);
  $('#suggest-status').textContent = 'Planning searches from your profile, running them, and ranking the results…';
  try {
    suggestions = await window.api.ai.recommendContacts();
    renderSuggestions();
    const added = suggestions.added || 0;
    $('#suggest-status').textContent = added === 0
      ? 'No new leads this round — your existing suggestions are unchanged. Try again after matching more opportunities.'
      : `Added ${added} new ${added === 1 ? 'person' : 'people'} to your list (${(suggestions.items || []).length} total).`;
  } catch (err) {
    $('#suggest-status').textContent = /API key not set/.test(err.message)
      ? 'Suggestions need both an Anthropic and a SerpAPI key — add them in Settings.'
      : `Suggestions failed: ${err.message}`;
  } finally {
    busy(e.target, false);
  }
});

// ── Assistant chat ────────────────────────────────────────────────────────────
// A context-aware chat panel. Whatever the user opened it from — a lesson,
// the resume, a project, or the app at large — rides along as grounding in
// the system prompt, so answers stay specific.

let chatMessages = [];    // API history: [{role, content}]
let chatContext = null;   // { label, text }
let currentChatId = null; // set once saved — later turns auto-persist

function addChatBubble(role, text) {
  const el = document.createElement('div');
  el.className = `chat-bubble chat-${role}`;
  if (role === 'assistant') el.innerHTML = mdToHtml(text);
  else el.textContent = text;
  $('#as-msgs').appendChild(el);
  $('#as-msgs').scrollTop = $('#as-msgs').scrollHeight;
  return el;
}

function showChatView() {
  $('#as-history-list').hidden = true;
  $('#as-msgs').hidden = false;
  $('#as-history').textContent = 'History';
}

function openAssistant(label, contextText, greeting) {
  // Same context: keep the running conversation. New context: start fresh.
  if (!chatContext || chatContext.text !== contextText) {
    chatContext = { label, text: contextText };
    chatMessages = [];
    currentChatId = null;
    $('#as-msgs').innerHTML = '';
    addChatBubble('assistant', greeting || 'What can I help you with?');
  }
  $('#as-context').textContent = label;
  showChatView();
  $('#assistant').hidden = false;
  $('#as-input').focus();
}

// ── Saved chats ───────────────────────────────────────────────────────────────
// "Save" keeps the conversation (context included); every later turn in a
// saved chat auto-persists. History lists them; clicking one resumes it.

function chatTitle() {
  const firstUser = chatMessages.find(m => m.role === 'user');
  return (firstUser ? firstUser.content : chatContext?.label || 'Chat').slice(0, 60);
}

async function persistChat() {
  if (!currentChatId) return;
  await window.api.chats.save({
    id: currentChatId,
    title: chatTitle(),
    context: chatContext,
    messages: chatMessages,
  });
}

$('#as-save').addEventListener('click', async e => {
  if (chatMessages.length === 0) return;
  if (!currentChatId) currentChatId = `chat-${Date.now()}`;
  await persistChat();
  e.target.textContent = 'Saved';
  setTimeout(() => { e.target.textContent = 'Save'; }, 1500);
});

function loadChat(chat) {
  chatContext = chat.context || null;
  chatMessages = [...(chat.messages || [])];
  currentChatId = chat.id;
  $('#as-context').textContent = chat.context?.label || '';
  $('#as-msgs').innerHTML = '';
  chatMessages.forEach(m => addChatBubble(m.role, m.content));
  showChatView();
  $('#as-input').focus();
}

async function renderChatHistory() {
  const list = $('#as-history-list');
  const chats = await window.api.chats.list();
  list.innerHTML = '';
  const items = Object.values(chats)
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  if (items.length === 0) {
    list.innerHTML = '<div class="empty">No saved chats yet. Click "Save" during a conversation to keep it here.</div>';
    return;
  }
  for (const chat of items) {
    const row = document.createElement('div');
    row.className = 'chat-hist-item';
    row.innerHTML = `
      <div class="row-info">
        <div class="row-title">${esc(chat.title || 'Chat')}</div>
        <div class="row-meta">${esc(chat.context?.label || '')} · ${(chat.messages || []).length} messages · ${timeAgo(chat.updatedAt)}</div>
      </div>`;
    const del = document.createElement('button');
    del.className = 'btn-x';
    del.setAttribute('aria-label', 'Delete chat');
    del.innerHTML = '&#10005;';
    del.addEventListener('click', async e => {
      e.stopPropagation();
      await window.api.chats.delete(chat.id);
      if (currentChatId === chat.id) currentChatId = null;
      renderChatHistory();
    });
    row.appendChild(del);
    row.addEventListener('click', () => loadChat(chat));
    list.appendChild(row);
  }
}

$('#as-history').addEventListener('click', async e => {
  if (!$('#as-history-list').hidden) { showChatView(); return; }
  await renderChatHistory();
  $('#as-msgs').hidden = true;
  $('#as-history-list').hidden = false;
  e.target.textContent = 'Back to chat';
});

async function sendChat() {
  const text = $('#as-input').value.trim();
  if (!text || $('#as-send').disabled) return;
  $('#as-input').value = '';
  chatMessages.push({ role: 'user', content: text });
  addChatBubble('user', text);
  const pending = addChatBubble('assistant', 'Thinking…');
  busy($('#as-send'), true);
  try {
    const reply = await window.api.ai.chat(chatContext, chatMessages);
    chatMessages.push({ role: 'assistant', content: reply });
    pending.innerHTML = mdToHtml(reply);
    await persistChat(); // no-op until the chat has been saved once
  } catch (err) {
    chatMessages.pop(); // drop the failed turn so a retry sends clean history
    pending.textContent = /API key not set/.test(err.message)
      ? 'Add your Anthropic API key in Settings to chat.'
      : `Error: ${err.message}`;
  } finally {
    busy($('#as-send'), false);
    $('#as-msgs').scrollTop = $('#as-msgs').scrollHeight;
    $('#as-input').focus();
  }
}

$('#as-send').addEventListener('click', sendChat);
$('#as-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$('#as-close').addEventListener('click', () => { $('#assistant').hidden = true; });

// Global entry point: sidebar button and the floating popup bubble, both
// grounded in an app-state summary.
function openGlobalAssistant() {
  const active = Object.values(opportunities)
    .filter(o => o.status === 'new' || o.status === 'saved');
  const top = active
    .filter(o => Number.isFinite(o.matchScore))
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 8)
    .map(o => `- ${displayTitle(o)} at ${titleCase(o.company || '')} (fit ${o.matchScore})`);
  const contextText =
    `Profile:\nName: ${$('#p-name').value}\n` +
    `School: ${$('#p-school').value}, ${$('#p-major').value}, class of ${$('#p-gradyear').value}\n` +
    `Goals: ${$('#p-goals').value}\nInterests: ${$('#p-interests').value}\n\n` +
    `App state: ${active.length} active opportunities, ` +
    `${Object.keys(contacts).length} contacts, ${Object.keys(courses).length} courses.\n` +
    `Top matches:\n${top.join('\n') || '(not matched yet)'}\n\n` +
    `Resume:\n${$('#p-resume').value.slice(0, 5000)}`;
  openAssistant('Your job hunt at a glance', contextText,
    'I can see your profile, top matches, and courses. Ask me anything — where to focus this week, what to apply to next, or how to prep.');
}

$('#btn-assistant').addEventListener('click', openGlobalAssistant);

// The popup bubble: reopen the current conversation if there is one,
// otherwise start a global chat.
$('#fab-assistant').addEventListener('click', () => {
  if (chatContext && chatMessages.length > 0) {
    showChatView();
    $('#assistant').hidden = false;
    $('#as-input').focus();
  } else {
    openGlobalAssistant();
  }
});

// ── Contact modal ─────────────────────────────────────────────────────────────

function openContactModal(email = null) {
  editingEmail = email;
  const c = email ? contacts[email] : null;
  $('#modal-title').textContent = c ? (c.name || c.email) : 'New Contact';
  $('#m-name').value    = c?.name || '';
  $('#m-email').value   = c?.email || '';
  $('#m-company').value = c?.company || '';
  $('#m-status').value  = c?.status || 'emailed';
  $('#m-notes').value   = c?.notes || '';
  $('#m-delete').hidden = !c;
  $('#m-ai-out').hidden = true;
  $('#modal').hidden = false;
}

function closeModal() { $('#modal').hidden = true; }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });

// Escape peels back one layer at a time: overlays first, then detail panes.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#assistant').hidden) { $('#assistant').hidden = true; return; }
  if (!$('#flashcards').hidden) { $('#flashcards').hidden = true; return; }
  if (!$('#modal').hidden) { closeModal(); return; }
  if (!$('#view-learn').hidden && !$('#learn-detail').hidden) { $('#btn-back-courses').click(); return; }
  if (!$('#view-companies').hidden && !$('#company-detail').hidden) { $('#btn-back-companies').click(); }
});

// Enter in a modal field saves the contact (textarea keeps Enter for newlines).
$('#modal').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    $('#m-save').click();
  }
});

// Left/right arrows and space drive the flashcard deck while it's open.
document.addEventListener('keydown', e => {
  if ($('#flashcards').hidden) return;
  if (e.key === 'ArrowRight') fcStep(1);
  else if (e.key === 'ArrowLeft') fcStep(-1);
  else if (e.key === ' ') { e.preventDefault(); $('#fc-flip').click(); }
});

$('#btn-add-contact').addEventListener('click', () => openContactModal());

$('#m-save').addEventListener('click', async () => {
  const email = $('#m-email').value.trim();
  if (!email) { alert('Email is required.'); return; }
  const prior = contacts[editingEmail || email];
  await window.api.contacts.save({
    email,
    name:    $('#m-name').value.trim(),
    company: $('#m-company').value.trim(),
    status:  $('#m-status').value,
    notes:   $('#m-notes').value,
    lastEmailedAt: $('#m-status').value === 'emailed' && prior?.status !== 'emailed'
      ? new Date().toISOString()
      : prior?.lastEmailedAt || (($('#m-status').value === 'emailed') ? new Date().toISOString() : null),
  });
  // If the email address itself was edited, remove the old record.
  if (editingEmail && editingEmail !== email) await window.api.contacts.delete(editingEmail);
  await refreshAll();
  closeModal();
});

$('#m-delete').addEventListener('click', async () => {
  if (!editingEmail) return;
  if (!confirm('Delete this contact?')) return;
  await window.api.contacts.delete(editingEmail);
  await refreshAll();
  closeModal();
});

// ── AI actions in modal ───────────────────────────────────────────────────────

let lastResearch = '';

function currentModalContact() {
  return {
    email:   $('#m-email').value.trim(),
    name:    $('#m-name').value.trim(),
    company: $('#m-company').value.trim(),
    notes:   $('#m-notes').value,
  };
}

async function runAI(button, label, fn) {
  const out = $('#m-ai-out');
  busy(button, true);
  const orig = button.textContent;
  button.textContent = 'Working…';
  try {
    const text = await fn();
    $('#m-ai-label').textContent = label;
    $('#m-ai-text').textContent = text;
    out.hidden = false;
    return text;
  } catch (err) {
    $('#m-ai-label').textContent = 'Error';
    $('#m-ai-text').textContent = err.message.includes('MISSING_KEY') || /API key not set/.test(err.message)
      ? 'No Anthropic API key configured. Add one in Settings → Anthropic API key to enable AI features.'
      : err.message;
    out.hidden = false;
  } finally {
    busy(button, false);
    button.textContent = orig;
  }
}

$('#m-research').addEventListener('click', async e => {
  const text = await runAI(e.target, 'Research brief', () =>
    window.api.ai.research(currentModalContact()));
  if (text) lastResearch = text;
});

$('#m-draft').addEventListener('click', e => {
  runAI(e.target, 'Email draft', () =>
    window.api.ai.draft(currentModalContact(), lastResearch, 'warm and direct'));
});

$('#m-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#m-ai-text').textContent);
  $('#m-copy').textContent = 'Copied';
  setTimeout(() => { $('#m-copy').textContent = 'Copy'; }, 1500);
});

// ── Opportunities ─────────────────────────────────────────────────────────────

// Postings whose title or explicit role tag matches one of the user's keywords.
function oppMatchesRole(o, role) {
  if (role === 'all') return true;
  const needle = role.toLowerCase();
  return (o.role || '').toLowerCase() === needle
    || (o.title || '').toLowerCase().includes(needle);
}

function renderRoleChips() {
  const bar = $('#opp-role-filters');
  const roles = appSettings.jobKeywords || [];
  bar.innerHTML = '';
  if (roles.length === 0) return;
  for (const role of ['all', ...roles]) {
    const chip = document.createElement('button');
    chip.className = `chip ${role === oppRoleFilter ? 'active' : ''}`;
    chip.textContent = role === 'all' ? 'All roles' : role;
    chip.addEventListener('click', () => {
      oppRoleFilter = role;
      renderRoleChips();
      renderOpps();
    });
    bar.appendChild(chip);
  }
}

// Short display title: cut trailing qualifiers ("… - Payments Platform",
// "… (Remote)") so the list scans cleanly. The full title lives in the
// expanded detail pane.
function displayTitle(o) {
  let t = (o.title || '').replace(/\[[^\]]*\]/g, ' ');
  t = t.split(/\s+[-–—|/]\s+|\s+\(/)[0].replace(/\s+/g, ' ').trim();
  if (t.length > 60) t = t.slice(0, 59).trimEnd() + '…';
  return titleCase(t) || 'Untitled role';
}

// Courses relevant to this posting: significant title words overlapping the
// course title or the role it was generated for.
function relatedCourses(o) {
  const stop = new Set(['with', 'from', 'this', 'that', 'team']);
  const words = displayTitle(o).toLowerCase().split(/[^a-z]+/)
    .filter(w => w.length > 3 && !stop.has(w));
  if (words.length === 0) return [];
  const needed = Math.min(2, words.length);
  return Object.values(courses).filter(c => {
    const hay = `${c.title} ${c.roleFor || ''}`.toLowerCase();
    return words.filter(w => hay.includes(w)).length >= needed;
  });
}

function detailBlock(label, text, muted = false) {
  const div = document.createElement('div');
  const l = document.createElement('div');
  l.className = 'opp-detail-label';
  l.textContent = label;
  const t = document.createElement('div');
  t.className = `opp-detail-text${muted ? ' muted' : ''}`;
  t.textContent = text;
  div.append(l, t);
  return div;
}

function fillOppDetail(detail, o) {
  detail.innerHTML = '';

  detail.appendChild(detailBlock('Role',
    `${o.title}\n${[o.company, o.location, o.source, timeAgo(o.postedAt || o.createdAt)].filter(Boolean).join(' · ')}`));

  if (o.matchReason) detail.appendChild(detailBlock('Why it fits you', o.matchReason));
  if (o.description) detail.appendChild(detailBlock('Posting excerpt', o.description, true));

  // Actions
  const actions = document.createElement('div');
  actions.className = 'btn-row';
  const btn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = `btn small${cls ? ' ' + cls : ''}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };
  if (o.url) btn('Open posting', 'primary', () => window.api.openExternal(o.url));
  if (o.company) btn('View company', '', () => openCompany(o.company));
  const setStatus = status => async () => {
    await window.api.opps.save({ ...o, status });
    await refreshAll();
  };
  btn('Save', '', setStatus('saved'));
  btn('Applied', '', setStatus('applied'));
  btn('Dismiss', '', setStatus('dismissed'));
  detail.appendChild(actions);

  // Learning: existing prep courses for this kind of role, or create one.
  const prep = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'opp-detail-label';
  label.textContent = 'Prepare for this role';
  prep.appendChild(label);

  const related = relatedCourses(o);
  const prepRow = document.createElement('div');
  prepRow.className = 'btn-row';
  for (const c of related.slice(0, 3)) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = `Course: ${c.title.slice(0, 40)}`;
    b.addEventListener('click', () => { showView('learn'); openCourse(c.id); });
    prepRow.appendChild(b);
  }
  const gen = document.createElement('button');
  gen.className = 'btn small';
  gen.textContent = related.length > 0 ? 'New prep course' : 'Create prep course';
  gen.addEventListener('click', async () => {
    busy(gen, true);
    gen.textContent = 'Building course…';
    try {
      const course = await window.api.ai.courseRole(displayTitle(o));
      await refreshLearn();
      showView('learn');
      openCourse(course.id);
      $('#btn-write-all').click(); // write every lesson immediately, in parallel
    } catch (err) {
      gen.textContent = /API key not set/.test(err.message)
        ? 'Needs Anthropic key (Settings)'
        : 'Failed — try again';
      // Surface the real error under the buttons instead of swallowing it.
      let errEl = prep.querySelector('.gen-error');
      if (!errEl) {
        errEl = document.createElement('p');
        errEl.className = 'hint gen-error';
        prep.appendChild(errEl);
      }
      errEl.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      busy(gen, false);
    }
  });
  prepRow.appendChild(gen);
  prep.appendChild(prepRow);
  detail.appendChild(prep);
}

function oppRow(o) {
  const item = document.createElement('div');
  item.className = 'opp-item';

  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row-info">
      <div class="row-title">${esc(displayTitle(o))}</div>
      <div class="row-meta">${esc([titleCase(o.company), o.location, o.source].filter(Boolean).join(' · '))}</div>
    </div>
    ${Number.isFinite(o.matchScore)
      ? `<span class="match-score ${o.matchScore >= 70 ? 'high' : o.matchScore < 40 ? 'low' : ''}"
              title="${esc(o.matchReason || '')}">${o.matchScore}%</span>`
      : ''}
    <span class="badge badge-${esc(o.status || 'new')}">${esc(STATUS_LABELS[o.status] || o.status)}</span>
    <span class="chevron">›</span>
  `;
  row.prepend(logoEl(o.company || o.title, 36));

  const detail = document.createElement('div');
  detail.className = 'opp-detail';
  detail.hidden = !expandedOpps.has(o.id);
  if (!detail.hidden) {
    fillOppDetail(detail, o);
    item.classList.add('expanded');
  }

  row.addEventListener('click', () => {
    const opening = detail.hidden;
    if (opening) {
      fillOppDetail(detail, o);
      expandedOpps.add(o.id);
    } else {
      expandedOpps.delete(o.id);
    }
    detail.hidden = !opening;
    item.classList.toggle('expanded', opening);
  });

  item.append(row, detail);
  return item;
}

let lastOppFilterSig = '';

function renderOpps() {
  const list = $('#opp-list');
  list.innerHTML = '';
  // Changing any filter starts pagination over from the first page.
  const sig = `${oppFilter}|${oppRoleFilter}|${oppTypeFilter}|${oppAreaFilter}`;
  if (sig !== lastOppFilterSig) { lastOppFilterSig = sig; oppShowLimit = OPP_PAGE; }
  const rows = Object.values(opportunities)
    .filter(o => oppFilter === 'active'
      ? (o.status === 'new' || o.status === 'saved')
      : o.status === oppFilter)
    .filter(o => oppMatchesRole(o, oppRoleFilter))
    .filter(o => {
      const level = classifyLevel(o.title);
      if (appSettings.hideSeniorRoles !== false && level === 'senior') return false;
      return oppTypeFilter === 'all' || level === oppTypeFilter;
    })
    .filter(o => {
      if (oppAreaFilter === 'all') return true;
      if (oppAreaFilter === 'remote') return /remote/i.test(`${o.location} ${o.title}`);
      const loc = (o.location || '').toLowerCase();
      // New York gets alias matching: postings say "NYC", "NY", or "New York".
      if (oppAreaFilter.toLowerCase() === 'new york') return /new york|nyc|\bny\b/.test(loc);
      return loc.includes(oppAreaFilter.toLowerCase());
    })
    .sort((a, b) =>
      // Matched postings sort by fit score; the rest fall back to recency.
      (Number.isFinite(b.matchScore) ? b.matchScore : -1) - (Number.isFinite(a.matchScore) ? a.matchScore : -1)
      || new Date(b.postedAt || b.createdAt || 0) - new Date(a.postedAt || a.createdAt || 0));
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const cta = document.createElement('button');
    cta.className = 'btn primary';
    cta.style.marginTop = '10px';
    if (Object.keys(opportunities).length === 0) {
      empty.textContent = 'Nothing here yet — pull postings from all your sources to get started.';
      cta.textContent = 'Fetch latest opportunities';
      cta.addEventListener('click', () => $('#btn-refresh-opps').click());
    } else {
      empty.textContent = 'Nothing matches the current filters.';
      cta.textContent = 'Reset filters';
      cta.addEventListener('click', () => {
        oppFilter = 'active'; oppRoleFilter = 'all'; oppTypeFilter = 'all'; oppAreaFilter = 'all';
        $$('#opp-filters .chip').forEach(c => c.classList.toggle('active', c.dataset.f === 'active'));
        $$('#opp-type-filters .chip').forEach(c => c.classList.toggle('active', c.dataset.t === 'all'));
        renderRoleChips(); renderAreaChips(); renderOpps();
      });
    }
    empty.appendChild(document.createElement('br'));
    empty.appendChild(cta);
    list.appendChild(empty);
    return;
  }

  // Paginate long lists: render a page at a time with a "show more" row.
  const visible = rows.slice(0, oppShowLimit);
  visible.forEach(o => list.appendChild(oppRow(o)));
  if (rows.length > oppShowLimit) {
    const more = document.createElement('button');
    more.className = 'btn';
    more.style.margin = '10px auto';
    more.style.display = 'block';
    more.textContent = `Show ${Math.min(OPP_PAGE, rows.length - oppShowLimit)} more of ${rows.length - oppShowLimit} remaining`;
    more.addEventListener('click', () => { oppShowLimit += OPP_PAGE; renderOpps(); });
    list.appendChild(more);
  }
}

// Area chips are derived from the locations actually present in the feed:
// the six most common cities, plus Remote when any posting mentions it.
function renderAreaChips() {
  const bar = $('#opp-area-filters');
  const counts = new Map();
  let remoteCount = 0;
  for (const o of Object.values(opportunities)) {
    if (o.status === 'dismissed') continue;
    if (/remote/i.test(`${o.location} ${o.title}`)) remoteCount++;
    const area = (o.location || '').split(/[,;·|]/)[0].trim();
    if (area && !/remote/i.test(area)) counts.set(area, (counts.get(area) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(e => e[0]);

  // The preferred area from Settings is always pinned, even when the feed
  // has few postings there yet.
  const pinned = (appSettings.jobLocation || '').split(',')[0].trim();
  if (pinned && !top.some(a => a.toLowerCase() === pinned.toLowerCase())) top.unshift(pinned);

  const options = ['all', ...(remoteCount > 0 ? ['remote'] : []), ...top];
  if (!options.includes(oppAreaFilter)) oppAreaFilter = 'all';

  bar.innerHTML = '';
  if (top.length === 0 && remoteCount === 0) return;
  for (const area of options) {
    const chip = document.createElement('button');
    chip.className = `chip ${area === oppAreaFilter ? 'active' : ''}`;
    chip.textContent = area === 'all' ? 'All areas' : area === 'remote' ? 'Remote' : area;
    chip.addEventListener('click', () => {
      oppAreaFilter = area;
      renderAreaChips();
      renderOpps();
    });
    bar.appendChild(chip);
  }
}

$('#opp-type-filters').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#opp-type-filters .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  oppTypeFilter = chip.dataset.t;
  renderOpps();
});

$('#opp-filters').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#opp-filters .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  oppFilter = chip.dataset.f;
  renderOpps();
});

$('#btn-refresh-opps').addEventListener('click', async e => {
  busy(e.target, true);
  $('#opp-status').textContent = 'Fetching from all your sources — job boards, aggregators, and watched careers pages…';
  try {
    const { added, total, errors } = await window.api.opps.refresh();
    $('#opp-status').textContent =
      `Found ${total} matching postings · ${added} new` +
      (errors.length ? ` · ${errors.length} source error(s): ${errors[0]}` : '');
    await refreshAll();
  } catch (err) {
    $('#opp-status').textContent = `Fetch failed: ${err.message}`;
  } finally {
    busy(e.target, false);
  }
});

$('#btn-match-opps').addEventListener('click', async e => {
  busy(e.target, true);
  $('#opp-status').textContent = 'Scoring postings against your profile with AI…';
  try {
    const { matched, rescored } = await window.api.ai.match();
    $('#opp-status').textContent = matched === 0
      ? 'No active postings to match. Fetch some first.'
      : rescored
        ? `Everything was already scored, so all ${matched} postings were re-scored fresh.`
        : `Scored ${matched} new postings (already-scored ones kept their results). Sorted best-fit first.`;
    await refreshAll();
  } catch (err) {
    $('#opp-status').textContent = /API key not set/.test(err.message)
      ? 'Add your Anthropic API key in Settings to enable matching.'
      : `Matching failed: ${err.message}`;
  } finally {
    busy(e.target, false);
  }
});

$('#btn-add-opp').addEventListener('click', async () => {
  const title = prompt('Opportunity title (e.g. "Senior SWE @ Acme"):');
  if (!title) return;
  const url = prompt('Link (optional):') || '';
  await window.api.opps.save({
    id: `manual-${Date.now()}`,
    source: 'Manual', title, url,
    company: title.split('@')[1]?.trim() || '',
    status: 'saved', kind: 'job',
  });
  await refreshAll();
});

// ── Forecast ──────────────────────────────────────────────────────────────────

const LIKELIHOOD_BADGE = { high: 'badge-applied', medium: 'badge-saved', low: 'badge-archived' };

function renderForecast(f) {
  const summary = $('#forecast-summary');
  const list = $('#forecast-list');
  list.innerHTML = '';

  if (!f) {
    summary.hidden = true;
    list.innerHTML = '<div class="empty">No forecast yet. Click "Generate forecast" and the AI will predict what openings are coming, using your feed\'s history and known recruiting cycles.</div>';
    return;
  }

  summary.textContent = f.summary || '';
  summary.hidden = !f.summary;
  $('#forecast-status').textContent = f.generatedAt ? `Last generated ${timeAgo(f.generatedAt)}` : '';

  for (const p of f.predictions || []) {
    const item = document.createElement('div');
    item.className = 'opp-item expanded';
    const badge = LIKELIHOOD_BADGE[p.likelihood] || 'badge-new';
    item.innerHTML = `
      <div class="row" style="cursor:default">
        <div class="row-info">
          <div class="row-title">${esc(titleCase(p.title || ''))}</div>
          <div class="row-meta">${esc([p.window, (p.companies || []).slice(0, 4).join(', ')].filter(Boolean).join(' · '))}</div>
        </div>
        <span class="badge ${badge}">${esc(p.likelihood || '')} likelihood</span>
      </div>
      <div class="opp-detail">
        ${p.rationale ? `<div><div class="opp-detail-label">Why</div><div class="opp-detail-text">${esc(p.rationale)}</div></div>` : ''}
        ${p.action ? `<div><div class="opp-detail-label">Do this now</div><div class="opp-detail-text">${esc(p.action)}</div></div>` : ''}
      </div>
    `;
    list.appendChild(item);
  }
}

$('#btn-gen-forecast').addEventListener('click', async e => {
  busy(e.target, true);
  $('#forecast-status').textContent = 'Analyzing your feed and the recruiting calendar…';
  try {
    const f = await window.api.forecast.generate();
    renderForecast(f);
  } catch (err) {
    $('#forecast-status').textContent = /API key not set/.test(err.message)
      ? 'Add your Anthropic API key in Settings to generate forecasts.'
      : `Forecast failed: ${err.message}`;
  } finally {
    busy(e.target, false);
  }
});

// ── Companies ─────────────────────────────────────────────────────────────────

// A company card exists for every company seen in opportunities, merged with
// any cached research from the db.
function allCompanyNames() {
  const names = new Map(); // lower-case key → display name
  for (const o of Object.values(opportunities)) {
    if (o.company && o.status !== 'dismissed') names.set(o.company.toLowerCase(), o.company);
  }
  for (const c of Object.values(companies)) {
    if (c.name) names.set(c.name.toLowerCase(), c.name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

function companyRecord(name) {
  return Object.values(companies).find(c => c.name?.toLowerCase() === name.toLowerCase()) || null;
}

function companyRoles(name) {
  return Object.values(opportunities).filter(o =>
    o.company?.toLowerCase() === name.toLowerCase() && o.status !== 'dismissed');
}

function renderCompanies() {
  const list = $('#company-list');
  list.innerHTML = '';
  const names = allCompanyNames();
  if (names.length === 0) {
    list.innerHTML = '<div class="empty">No companies yet — fetch some opportunities first and every company will show up here.</div>';
    return;
  }
  for (const name of names) {
    const rec = companyRecord(name);
    const roles = companyRoles(name);
    const card = document.createElement('div');
    card.className = 'company-card';
    card.appendChild(logoEl(name, 48));

    const title = document.createElement('div');
    title.className = 'company-card-name';
    title.textContent = titleCase(name);
    title.title = titleCase(name);
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'company-card-meta';
    meta.textContent = `${roles.length} open role${roles.length === 1 ? '' : 's'}`;
    card.appendChild(meta);

    if (rec?.brief) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-applied';
      badge.textContent = 'Researched';
      card.appendChild(badge);
    }

    card.addEventListener('click', () => openCompany(name));
    list.appendChild(card);
  }
}

function linkItem(title, url, meta) {
  const div = document.createElement('div');
  div.className = 'link-item';
  const a = document.createElement('a');
  a.textContent = title;
  a.addEventListener('click', () => window.api.openExternal(url));
  div.appendChild(a);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'link-meta';
    m.textContent = meta;
    div.appendChild(m);
  }
  return div;
}

function renderCompanyDetail() {
  const name = activeCompany;
  const rec = companyRecord(name);
  const roles = companyRoles(name);

  $('#company-name').textContent = titleCase(name);
  $('#company-sub').textContent = `${roles.length} open role${roles.length === 1 ? '' : 's'} in your feed`;
  $('#company-logo').replaceChildren(logoEl(name, 46));

  const rolesEl = $('#company-roles');
  rolesEl.innerHTML = roles.length === 0 ? '<div class="empty">No open roles from this company in your feed right now.</div>' : '';
  roles.forEach(o => rolesEl.appendChild(oppRow(o)));

  const briefEl = $('#company-brief');
  if (rec?.brief) {
    briefEl.innerHTML = mdToHtml(rec.brief);
    briefEl.classList.remove('placeholder');
  } else {
    briefEl.textContent = 'No research yet. Click "Run deep research" to pull recent news, initiatives, and deals.';
    briefEl.classList.add('placeholder');
  }

  const newsEl = $('#company-news');
  newsEl.innerHTML = '';
  if (rec?.news?.length) {
    rec.news.forEach(n => newsEl.appendChild(linkItem(n.title, n.link, [n.source, n.date].filter(Boolean).join(' · '))));
  } else {
    newsEl.innerHTML = '<div class="empty">Run deep research to see recent articles here.</div>';
  }

  const filingsEl = $('#company-filings');
  filingsEl.innerHTML = '';
  const filings = rec?.filings || [];
  $('#company-filings-title').hidden = filings.length === 0;
  filings.forEach(f => filingsEl.appendChild(
    linkItem(`${f.form} — ${f.title}`, f.url, `Filed ${f.date}${rec.ticker ? ` · ${rec.ticker}` : ''}`)));

  const leadsEl = $('#company-leads');
  leadsEl.innerHTML = '';
  if (rec?.leads?.length) {
    rec.leads.forEach(l => leadsEl.appendChild(
      linkItem(l.name + (l.role ? ` — ${l.role}` : ''), l.url, `Shared with you: ${l.sharedWith || 'unknown'} (unverified)`)));
  } else {
    leadsEl.innerHTML = '<div class="empty">Click "Find possible connections" to search public profiles for shared schools and organizations.</div>';
  }
}

function openCompany(name) {
  activeCompany = name;
  // Switch to the Companies view if we came from elsewhere (e.g. a posting row).
  showView('companies');
  $('#companies-home').hidden = true;
  $('#company-detail').hidden = false;
  $('#company-status').textContent = '';
  renderCompanyDetail();
}

$('#btn-back-companies').addEventListener('click', () => {
  activeCompany = null;
  $('#company-detail').hidden = true;
  $('#companies-home').hidden = false;
  renderCompanies();
});

async function runCompanyAction(button, statusMsg, fn) {
  busy(button, true);
  $('#company-status').textContent = statusMsg;
  try {
    await fn();
    $('#company-status').textContent = '';
    companies = await window.api.companies.list();
    renderCompanyDetail();
  } catch (err) {
    $('#company-status').textContent = /API key not set/.test(err.message)
      ? err.message.includes('SerpAPI')
        ? 'This needs a SerpAPI key — add it in Settings.'
        : 'This needs an Anthropic API key — add it in Settings.'
      : `Failed: ${err.message}`;
  } finally {
    busy(button, false);
  }
}

$('#btn-company-research').addEventListener('click', e =>
  runCompanyAction(e.target, `Researching ${activeCompany} — news, initiatives, deals…`,
    () => window.api.ai.companyResearch(activeCompany)));

$('#btn-company-leads').addEventListener('click', e =>
  runCompanyAction(e.target, `Searching public profiles for people you may share a background with…`,
    async () => {
      const { note } = await window.api.ai.companyLeads(activeCompany);
      if (note) throw new Error(note);
    }));

// ── Profile ───────────────────────────────────────────────────────────────────

const PROFILE_FIELDS = {
  'p-name': 'name', 'p-email': 'email', 'p-phone': 'phone', 'p-location': 'location',
  'p-school': 'school', 'p-major': 'major', 'p-gradyear': 'gradYear',
  'p-github': 'github', 'p-linkedin': 'linkedin', 'p-portfolio': 'portfolio',
  'p-goals': 'goals', 'p-resume': 'resumeText',
};

async function loadProfile() {
  const p = await window.api.profile.get();
  for (const [id, key] of Object.entries(PROFILE_FIELDS)) $(`#${id}`).value = p[key] || '';
  $('#p-interests').value = (p.interests || []).join(', ');
}

async function persistProfile() {
  const updates = {};
  for (const [id, key] of Object.entries(PROFILE_FIELDS)) updates[key] = $(`#${id}`).value.trim();
  updates.resumeText = $('#p-resume').value; // keep resume formatting intact
  updates.interests = $('#p-interests').value.split(',').map(s => s.trim()).filter(Boolean);
  await window.api.profile.save(updates);
}

$('#btn-save-profile').addEventListener('click', async e => {
  await persistProfile();
  e.target.textContent = 'Saved';
  setTimeout(() => { e.target.textContent = 'Save profile'; }, 1500);
});

$('#btn-import-resume').addEventListener('click', async () => {
  try {
    const file = await window.api.files.pickText();
    if (!file) return;
    $('#p-resume').value = file.text;
    $('#resume-status').textContent = `Imported ${file.name} (${file.text.length.toLocaleString()} characters). Remember to save.`;
  } catch (err) {
    $('#resume-status').textContent = `Import failed: ${err.message}`;
  }
});

$('#btn-resume-feedback').addEventListener('click', async e => {
  const out = $('#resume-feedback');
  busy(e.target, true);
  $('#resume-status').textContent = 'Reviewing your resume against your goals…';
  try {
    // Save first so the review sees exactly what's on screen.
    await persistProfile();
    const feedback = await window.api.ai.resumeFeedback();
    out.innerHTML = mdToHtml(feedback);
    out.hidden = false;
    $('#resume-status').textContent = '';
  } catch (err) {
    $('#resume-status').textContent = /API key not set/.test(err.message)
      ? 'Add your Anthropic API key in Settings first.'
      : err.message;
  } finally {
    busy(e.target, false);
  }
});

// Resume-focused assistant entry point on the profile page.
$('#btn-resume-chat').addEventListener('click', () => {
  const resume = $('#p-resume').value;
  if (!resume.trim()) { $('#resume-status').textContent = 'Paste or import a resume first.'; return; }
  const contextText =
    `Goals: ${$('#p-goals').value || '(unspecified)'}\n` +
    `Interests: ${$('#p-interests').value}\n` +
    `Grad year: ${$('#p-gradyear').value}\n\nResume:\n${resume.slice(0, 10000)}`;
  openAssistant('Your resume', contextText,
    'I have your resume loaded. Ask about wording, what to add or cut, how to frame something — or paste a job posting and I\'ll tailor advice to it.');
});

// ── Learn ─────────────────────────────────────────────────────────────────────

function courseProgress(course) {
  const lessons = course.modules.flatMap(m => m.lessons);
  const done = lessons.filter(l => l.done).length;
  return { done, total: lessons.length };
}

function renderCourses() {
  const list = $('#course-list');
  list.innerHTML = '';
  const rows = Object.values(courses)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">No courses yet. Generate one for a target role, or import a class syllabus.</div>';
    return;
  }
  for (const course of rows) {
    const { done, total } = courseProgress(course);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="avatar" style="background:${avatarColor(course.title)}">${esc(initials(course.title))}</div>
      <div class="row-info">
        <div class="row-title">${esc(course.title)}</div>
        <div class="row-meta">${course.source === 'syllabus' ? 'From your syllabus' : 'Role preparation'} · ${done}/${total} lessons complete</div>
        <div class="progress"><div class="progress-fill" style="width:${total > 0 ? Math.round((done / total) * 100) : 0}%"></div></div>
      </div>
      <span class="badge ${done === total && total > 0 ? 'badge-applied' : 'badge-new'}">${done === total && total > 0 ? 'Complete' : 'In progress'}</span>
    `;
    row.addEventListener('click', () => openCourse(course.id));
    list.appendChild(row);
  }
}

function openCourse(id) {
  activeCourseId = id;
  $('#learn-home').hidden = true;
  $('#learn-detail').hidden = false;
  renderCourseDetail();
}

function renderCourseDetail() {
  const course = courses[activeCourseId];
  if (!course) return;
  const { done, total } = courseProgress(course);
  $('#course-title').textContent = course.title;
  $('#course-progress').textContent = `${done} of ${total} lessons complete`;
  $('#course-progress-bar').firstElementChild.style.width =
    `${total > 0 ? Math.round((done / total) * 100) : 0}%`;

  const outline = $('#lesson-outline');
  outline.innerHTML = '';

  course.modules.forEach((mod, mi) => {
    const modEl = document.createElement('div');
    modEl.className = 'module';
    modEl.innerHTML = `<div class="module-head">${mi + 1}. ${esc(mod.title)}</div>`;

    mod.lessons.forEach((lesson, li) => {
      const lessonEl = document.createElement('div');
      lessonEl.className = 'lesson';
      lessonEl.innerHTML = `
        <div class="lesson-row">
          <span class="lesson-check ${lesson.done ? 'done' : ''}">${lesson.done ? '&#10003;' : ''}</span>
          <span class="lesson-title ${lesson.done ? 'done' : ''}">${esc(lesson.title)}</span>
          <span class="lesson-summary">${esc(lesson.summary || '')}</span>
        </div>
        <div class="lesson-content" hidden></div>
      `;

      const contentEl = lessonEl.querySelector('.lesson-content');

      lessonEl.querySelector('.lesson-row').addEventListener('click', async () => {
        if (!contentEl.hidden) { contentEl.hidden = true; return; }

        if (!lesson.content) {
          contentEl.hidden = false;
          contentEl.textContent = 'Writing this lesson for you…';
          try {
            lesson.content = await window.api.ai.lesson(course.id, mi, li);
          } catch (err) {
            contentEl.textContent = /API key not set/.test(err.message)
              ? 'Add your Anthropic API key in Settings to unlock lessons.'
              : `Could not generate lesson: ${err.message}`;
            return;
          }
        }
        contentEl.innerHTML = mdToHtml(lesson.content);

        const actions = document.createElement('div');
        actions.className = 'btn-row';

        const doneBtn = document.createElement('button');
        doneBtn.className = 'btn small';
        doneBtn.textContent = lesson.done ? 'Mark as not done' : 'Mark lesson complete';
        doneBtn.addEventListener('click', async e => {
          e.stopPropagation();
          lesson.done = !lesson.done;
          await window.api.courses.save(course);
          await refreshLearn();
          renderCourseDetail();
        });
        actions.appendChild(doneBtn);

        const watchBtn = document.createElement('button');
        watchBtn.className = 'btn small';
        watchBtn.textContent = 'Watch videos';
        watchBtn.addEventListener('click', e => {
          e.stopPropagation();
          showLessonVideos(course, lesson, contentEl, watchBtn);
        });
        actions.appendChild(watchBtn);

        const quizBtn = document.createElement('button');
        quizBtn.className = 'btn small';
        quizBtn.textContent = lesson.quiz?.length ? 'Show quiz' : 'Quiz me';
        quizBtn.addEventListener('click', async e => {
          e.stopPropagation();
          if (!lesson.quiz?.length) {
            busy(quizBtn, true);
            try {
              lesson.quiz = await window.api.ai.quiz(course.id, mi, li);
            } catch (err) {
              quizBtn.textContent = /API key not set/.test(err.message)
                ? 'Needs Anthropic key'
                : 'Quiz failed — retry';
              return;
            } finally {
              busy(quizBtn, false);
            }
          }
          renderQuiz(contentEl, lesson.quiz);
          quizBtn.textContent = 'Show quiz';
        });
        actions.appendChild(quizBtn);

        const askBtn = document.createElement('button');
        askBtn.className = 'btn small';
        askBtn.textContent = 'Ask the assistant';
        askBtn.addEventListener('click', e => {
          e.stopPropagation();
          openAssistant(`Lesson: ${lesson.title}`,
            (`Course: ${course.title}\nModule: ${mod.title}\nLesson: ${lesson.title}\n\n` +
             (lesson.content || lesson.summary || '')).slice(0, 12000),
            `I have "${lesson.title}" loaded. Ask me to explain anything here differently, walk through another example, or go deeper on a point.`);
        });
        actions.appendChild(askBtn);

        contentEl.appendChild(actions);
        contentEl.hidden = false;
      });

      modEl.appendChild(lessonEl);
    });
    outline.appendChild(modEl);
  });

  renderCourseProjects(course);
}

// Hands-on, resume-worthy projects attached to the course. New courses get
// them from the outline; older ones can generate them here.
function renderCourseProjects(course) {
  const box = $('#course-projects');
  box.innerHTML = '';

  const projects = course.projects || [];
  if (projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No projects for this course yet.';
    const gen = document.createElement('button');
    gen.className = 'btn primary';
    gen.style.marginTop = '10px';
    gen.textContent = 'Generate projects';
    gen.addEventListener('click', async () => {
      busy(gen, true);
      try {
        await window.api.ai.courseProjects(course.id);
        await refreshLearn();
        renderCourseDetail();
      } catch (err) {
        gen.textContent = /API key not set/.test(err.message)
          ? 'Needs Anthropic key'
          : 'Failed — try again';
        busy(gen, false);
      }
    });
    empty.appendChild(document.createElement('br'));
    empty.appendChild(gen);
    box.appendChild(empty);
    return;
  }

  projects.forEach(p => {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <div class="project-head">
        <div class="row-title">${esc(p.title)}</div>
        <span class="badge ${p.difficulty === 'hard' ? 'badge-needs_follow_up' : 'badge-saved'}">${esc(p.difficulty || 'challenging')}</span>
      </div>
      <p class="project-brief">${esc(p.brief || '')}</p>
      ${(p.steps || []).length ? `<ol class="project-steps">${p.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
      ${p.stretch ? `<p class="project-stretch"><strong>Stretch:</strong> ${esc(p.stretch)}</p>` : ''}
      ${p.resumeBullet ? `<p class="project-bullet">${esc(p.resumeBullet)}</p>` : ''}
    `;
    const ask = document.createElement('button');
    ask.className = 'btn small';
    ask.textContent = 'Work on this with the assistant';
    ask.addEventListener('click', () => openAssistant(`Project: ${p.title}`,
      `Course: ${course.title}\nProject: ${p.title}\nDifficulty: ${p.difficulty || ''}\n` +
      `Brief: ${p.brief || ''}\nMilestones: ${(p.steps || []).join(' | ')}\nStretch: ${p.stretch || ''}`,
      `Let's build "${p.title}". Ask me how to start, get unstuck on a step, or review your approach — I'll keep the milestones in mind.`));
    card.appendChild(ask);
    box.appendChild(card);
  });
}

// Curated videos for a lesson: direct links via the YouTube Data API when a
// key is set, otherwise a YouTube search in the default browser.
async function showLessonVideos(course, lesson, contentEl, btn) {
  const q = `${lesson.title} ${course.roleFor || course.title}`;
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  if (!appSettings.youtubeApiKey) { window.api.openExternal(searchUrl); return; }

  busy(btn, true);
  try {
    const res = await fetch('https://www.googleapis.com/youtube/v3/search?' + new URLSearchParams({
      part: 'snippet', type: 'video', maxResults: '3', q, key: appSettings.youtubeApiKey,
    }));
    if (!res.ok) throw new Error(`YouTube API ${res.status}`);
    const data = await res.json();
    const vids = (data.items || [])
      .filter(v => v.id?.videoId)
      .map(v => ({
        title: decodeEntities(v.snippet?.title || 'Video'),
        url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
      }));
    if (vids.length === 0) throw new Error('no results');

    let box = contentEl.querySelector('.video-links');
    if (box) box.remove();
    box = document.createElement('div');
    box.className = 'video-links';
    vids.forEach(v => box.appendChild(linkItem(v.title, v.url, 'YouTube')));
    contentEl.appendChild(box);
  } catch {
    window.api.openExternal(searchUrl); // API problem — fall back to a search
  } finally {
    busy(btn, false);
  }
}

// Render a click-to-reveal quiz below the lesson content.
function renderQuiz(contentEl, quiz) {
  let box = contentEl.querySelector('.quiz');
  if (box) box.remove();
  box = document.createElement('div');
  box.className = 'quiz';
  quiz.forEach((item, i) => {
    const qEl = document.createElement('div');
    qEl.className = 'quiz-item';
    const question = document.createElement('div');
    question.className = 'quiz-q';
    question.textContent = `${i + 1}. ${item.q}`;
    const ans = document.createElement('div');
    ans.className = 'quiz-a';
    ans.textContent = item.a;
    ans.hidden = true;
    const reveal = document.createElement('button');
    reveal.className = 'btn small';
    reveal.textContent = 'Show answer';
    reveal.addEventListener('click', e => {
      e.stopPropagation();
      ans.hidden = false;
      reveal.hidden = true;
    });
    qEl.append(question, reveal, ans);
    box.appendChild(qEl);
  });
  contentEl.appendChild(box);
}

// ── Flashcard review ──────────────────────────────────────────────────────────
// Completed lessons become review cards: their quiz Q/As plus an
// explain-the-concept card from each lesson summary.

let fcCards = [];
let fcIndex = 0;
let fcFlipped = false;

function flashcardsFor(course) {
  const cards = [];
  for (const mod of course.modules || []) {
    for (const lesson of mod.lessons || []) {
      if (!lesson.done) continue;
      for (const item of lesson.quiz || []) {
        if (item.q && item.a) cards.push({ front: item.q, back: item.a });
      }
      if (lesson.summary) cards.push({ front: `Explain: ${lesson.title}`, back: lesson.summary });
    }
  }
  return cards.sort(() => Math.random() - 0.5); // vary the order each session
}

function renderFlashcard() {
  const card = fcCards[fcIndex];
  $('#fc-label').textContent = fcFlipped ? 'Answer' : 'Question';
  $('#fc-text').textContent = fcFlipped ? card.back : card.front;
  $('#fc-flip').textContent = fcFlipped ? 'Show question' : 'Show answer';
  $('#fc-count').textContent = `${fcIndex + 1} of ${fcCards.length}`;
}

function openFlashcards() {
  const course = courses[activeCourseId];
  if (!course) return;
  fcCards = flashcardsFor(course);
  if (fcCards.length === 0) {
    fcCards = [{
      front: 'No flashcards yet.',
      back: 'Mark lessons complete and take their quizzes — completed lessons become review cards.',
    }];
  }
  fcIndex = 0;
  fcFlipped = false;
  $('#fc-title').textContent = `Review: ${course.title.slice(0, 40)}`;
  $('#flashcards').hidden = false;
  renderFlashcard();
}

function fcStep(dir) {
  fcIndex = (fcIndex + dir + fcCards.length) % fcCards.length;
  fcFlipped = false;
  renderFlashcard();
}

$('#btn-review-course').addEventListener('click', openFlashcards);
$('#fc-close').addEventListener('click', () => { $('#flashcards').hidden = true; });
$('#fc-flip').addEventListener('click', () => { fcFlipped = !fcFlipped; renderFlashcard(); });
$('#fc-card').addEventListener('click', () => { fcFlipped = !fcFlipped; renderFlashcard(); });
$('#fc-prev').addEventListener('click', () => fcStep(-1));
$('#fc-next').addEventListener('click', () => fcStep(1));
$('#flashcards').addEventListener('click', e => {
  if (e.target === $('#flashcards')) $('#flashcards').hidden = true;
});

$('#btn-back-courses').addEventListener('click', () => {
  activeCourseId = null;
  $('#learn-detail').hidden = true;
  $('#learn-home').hidden = false;
  renderCourses();
});

$('#btn-delete-course').addEventListener('click', async () => {
  if (!activeCourseId || !confirm('Delete this course and all its lessons?')) return;
  await window.api.courses.delete(activeCourseId);
  await refreshLearn();
  $('#btn-back-courses').click();
});

// Generate the whole course at once: one AI call per module, modules in
// parallel — so the wall-clock cost is roughly a single call. If everything
// is already written, offers a full rewrite (deeper, fresh content).
$('#btn-write-all').addEventListener('click', async e => {
  const courseId = activeCourseId;
  const course = courses[courseId];
  if (!course) return;

  const missing = course.modules.reduce(
    (n, m) => n + m.lessons.filter(l => !l.content).length, 0);
  let force = false;
  if (missing === 0) {
    if (!confirm('Every lesson is already written. Rewrite the whole course with fresh, more detailed lessons?')) return;
    force = true;
  }

  busy(e.target, true);
  let written = 0;
  let failedModules = 0;
  let doneModules = 0;
  const progress = () => {
    $('#course-progress').textContent =
      `Writing lessons — ${doneModules} of ${course.modules.length} modules done…`;
  };
  progress();

  await Promise.all(course.modules.map((_, mi) =>
    window.api.ai.writeModule(courseId, mi, force)
      .then(r => { written += r.written; })
      .catch(() => { failedModules++; })
      .finally(() => { doneModules++; progress(); })));

  await refreshLearn();
  if (activeCourseId === courseId) {
    renderCourseDetail();
    $('#course-progress').textContent = failedModules > 0
      ? `Wrote ${written} lessons; ${failedModules} module${failedModules > 1 ? 's' : ''} failed — click those lessons to write them individually.`
      : `All ${written} lessons written — click any lesson to read it.`;
  }
  busy(e.target, false);
});

$('#btn-gen-course').addEventListener('click', async e => {
  const role = $('#l-role').value.trim();
  if (!role) { $('#learn-status').textContent = 'Type a target role first.'; return; }
  busy(e.target, true);
  $('#learn-status').textContent = `Designing a curriculum for "${role}"…`;
  try {
    const course = await window.api.ai.courseRole(role);
    await refreshLearn();
    $('#learn-status').textContent = '';
    openCourse(course.id);
    $('#btn-write-all').click(); // write every lesson immediately, in parallel
  } catch (err) {
    $('#learn-status').textContent = /API key not set/.test(err.message)
      ? 'Add your Anthropic API key in Settings to generate courses.'
      : `Course generation failed: ${err.message}`;
  } finally {
    busy(e.target, false);
  }
});

$('#btn-import-syllabus').addEventListener('click', async e => {
  const file = await window.api.files.pickText();
  if (!file) return;
  busy(e.target, true);
  $('#learn-status').textContent = `Reading ${file.name} and building your study plan…`;
  try {
    const course = await window.api.ai.courseSyllabus(file.text, file.name.replace(/\.(pdf|txt|md)$/i, ''));
    await refreshLearn();
    $('#learn-status').textContent = '';
    openCourse(course.id);
    $('#btn-write-all').click(); // write every lesson immediately, in parallel
  } catch (err) {
    $('#learn-status').textContent = /API key not set/.test(err.message)
      ? 'Add your Anthropic API key in Settings to import syllabi.'
      : `Syllabus import failed: ${err.message}`;
  } finally {
    busy(e.target, false);
  }
});

async function refreshLearn() {
  courses = await window.api.courses.list();
  renderCourses();
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await window.api.settings.get();
  appSettings = s;
  $('#s-anthropic').value  = s.anthropicApiKey || '';
  $('#s-serp').value       = s.serpApiKey || '';
  $('#s-youtube').value    = s.youtubeApiKey || '';
  $('#s-days').value       = s.followUpDays;
  $('#s-keywords').value   = (s.jobKeywords || []).join(', ');
  $('#s-greenhouse').value = (s.greenhouseBoards || []).join(', ');
  $('#s-lever').value      = (s.leverBoards || []).join(', ');
  $('#s-ashby').value      = (s.ashbyBoards || []).join(', ');
  $('#s-smartrecruiters').value = (s.smartrecruitersBoards || []).join(', ');
  $('#s-workable').value   = (s.workableBoards || []).join(', ');
  $('#s-careers').value    = (s.careersPages || []).join('\n');
  $('#s-usajobs-email').value = s.usaJobsEmail || '';
  $('#s-usajobs-key').value   = s.usaJobsKey || '';
  $('#s-adzuna-id').value     = s.adzunaAppId || '';
  $('#s-adzuna-key').value    = s.adzunaAppKey || '';
  $('#s-hide-senior').checked = s.hideSeniorRoles !== false;
  $('#s-location').value = s.jobLocation || '';
  $('#ai-status').textContent = s.anthropicApiKey ? 'AI enabled' : 'AI off — add key in Settings';
  $('#ai-dot').classList.toggle('on', !!s.anthropicApiKey);
  renderRoleChips();
}

const csv = v => v.split(',').map(x => x.trim()).filter(Boolean);

$('#btn-save-settings').addEventListener('click', async () => {
  await window.api.settings.save({
    anthropicApiKey:  $('#s-anthropic').value.trim(),
    serpApiKey:       $('#s-serp').value.trim(),
    youtubeApiKey:    $('#s-youtube').value.trim(),
    followUpDays:     Math.max(1, parseInt($('#s-days').value, 10) || 14),
    jobKeywords:      csv($('#s-keywords').value),
    greenhouseBoards: csv($('#s-greenhouse').value),
    leverBoards:      csv($('#s-lever').value),
    ashbyBoards:      csv($('#s-ashby').value),
    smartrecruitersBoards: csv($('#s-smartrecruiters').value),
    workableBoards:   csv($('#s-workable').value),
    careersPages:     $('#s-careers').value.split(/\n+/).map(u => u.trim()).filter(u => /^https?:\/\//.test(u)),
    usaJobsEmail:     $('#s-usajobs-email').value.trim(),
    usaJobsKey:       $('#s-usajobs-key').value.trim(),
    adzunaAppId:      $('#s-adzuna-id').value.trim(),
    adzunaAppKey:     $('#s-adzuna-key').value.trim(),
    hideSeniorRoles:  $('#s-hide-senior').checked,
    jobLocation:      $('#s-location').value.trim(),
  });
  $('#settings-status').textContent = 'Saved';
  setTimeout(() => { $('#settings-status').textContent = ''; }, 2000);
  await loadSettings();
  renderOpps();
});

// AI reads the resume and appends fitting titles/sectors/companies to the
// keyword list (saved immediately — the field and role chips refresh).
$('#btn-suggest-keywords').addEventListener('click', async e => {
  busy(e.target, true);
  $('#settings-status').textContent = 'Reading your resume for keywords…';
  try {
    const { added } = await window.api.ai.suggestKeywords();
    await loadSettings();
    $('#settings-status').textContent = added === 0
      ? 'No new keywords — your list already covers the resume.'
      : `Added ${added} keyword${added === 1 ? '' : 's'} from your resume.`;
    renderOpps();
  } catch (err) {
    $('#settings-status').textContent = /API key not set/.test(err.message)
      ? 'Add your Anthropic API key first.'
      : err.message;
  } finally {
    busy(e.target, false);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function refreshAll() {
  [contacts, opportunities, companies] = await Promise.all([
    window.api.contacts.list(),
    window.api.opps.list(),
    window.api.companies.list(),
  ]);
  renderDashboard();
  renderContacts();
  renderRoleChips();
  renderAreaChips();
  renderOpps();
  if (activeCompany) renderCompanyDetail();
  else renderCompanies();
}

window.api.onContactsChanged(() => refreshAll());

// One-shot "since your last visit" strip on the Dashboard, computed against
// the timestamp stored at the end of the previous session's boot.
function renderWhatsNew() {
  const prev = localStorage.getItem('lastLaunchAt');
  localStorage.setItem('lastLaunchAt', new Date().toISOString());
  if (!prev) return;
  const fresh = Object.values(opportunities)
    .filter(o => o.status !== 'dismissed' && (o.createdAt || '') > prev);
  if (fresh.length === 0) return;
  const fits = fresh.filter(o => (o.matchScore || 0) >= 70).length;
  const el = $('#whats-new');
  el.textContent = `Since your last visit: ${fresh.length} new opportunit${fresh.length === 1 ? 'y' : 'ies'}`
    + (fits > 0 ? `, ${fits} strong fit${fits > 1 ? 's' : ''}` : '')
    + '.';
  el.hidden = false;
}

(async () => {
  await loadSettings();
  await loadProfile();
  await refreshLearn();
  await refreshAll();
  renderWhatsNew();
  renderForecast(await window.api.forecast.get());
  suggestions = await window.api.contacts.suggestions();
  renderSuggestions();
})();
