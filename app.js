/* Session Viewer — reads local Claude Code and Codex transcripts. No dependencies. */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const DEFAULTS = {fontSize:17, fontFamily:'serif', lineWidth:68, lineHeight:16, theme:'auto', density:'comfortable',
                  toolView:'full', reminders:false, timestamps:false, tokens:true, focus:false, split:false,
                  following:true, sort:'recent', source:'', project:''};
const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('csv-settings') || '{}'));
const state = {sessions: [], filter: '', selected: null, savedFilter: ''};
const saved = JSON.parse(localStorage.getItem('csv-session-notes') || '{}');
const saveSaved = () => localStorage.setItem('csv-session-notes', JSON.stringify(saved));
const savedFor = id => saved[id] || {};
const sessionTitle = s => savedFor(s.id).title?.trim() || s.title;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const oneLine = (s, n = 150) => {const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t};
const save = () => localStorage.setItem('csv-settings', JSON.stringify(settings));

/* --------------------------------------------------------------- formatting */
const fmtDate = s => {const d = new Date(s); return isNaN(d) ? (s || 'unknown date') : d.toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'})};
const fmtTime = s => {const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'})};
function relTime(s){
  const d = new Date(s); if (isNaN(d)) return '';
  const mins = (Date.now() - d) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 43200) return `${Math.round(mins / 1440)}d ago`;
  return fmtDate(s);
}
function duration(a, b){
  const n = (new Date(b) - new Date(a)) / 1000;
  if (!isFinite(n) || n < 0) return '';
  return n < 60 ? `${Math.round(n)}s` : n < 3600 ? `${Math.round(n / 60)}m` : `${(n / 3600).toFixed(1)}h`;
}
const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
const compact = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0);
const modelName = m => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const chatId = s => String(s?.id || '').replace(/^(codex|claude):/i, '');
function resumeCommand(s){
  const id = chatId(s);
  if (!id) return '';
  return String(s?.source || '').toLowerCase() === 'codex'
    ? `codex resume ${id}`
    : String(s?.source || '').toLowerCase() === 'claude' ? `claude --resume ${id}` : '';
}

function toast(message, kind){
  const el = $('#toast');
  el.textContent = message;
  el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = '', 2600);
}

async function api(url, options){
  // The checked-in demo archive powers README screenshots without reading a real transcript.
  if (new URLSearchParams(location.search).has('demo')) url += (url.includes('?') ? '&' : '?') + 'demo=1';
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/* ----------------------------------------------------------------- settings */
function applySettings(){
  const r = document.documentElement;
  r.style.setProperty('--body-size', settings.fontSize + 'px');
  r.style.setProperty('--measure', settings.lineWidth + 'ch');
  r.style.setProperty('--leading', settings.lineHeight / 10);
  r.style.setProperty('--body-font', settings.fontFamily === 'serif'
    ? 'ui-serif, Georgia, Cambria, "Times New Roman", serif'
    : settings.fontFamily === 'sans' ? 'ui-sans-serif, system-ui, sans-serif' : 'ui-monospace, SFMono-Regular, Menlo, monospace');
  document.body.classList.toggle('compact', settings.density === 'compact');
  document.body.classList.toggle('split', settings.split);
  document.body.classList.remove('theme-auto', 'theme-light', 'theme-dark');
  document.body.classList.add('theme-' + settings.theme);
  for (const [id, key] of [['font-size','fontSize'], ['font-family','fontFamily'], ['line-width','lineWidth'],
                           ['line-height','lineHeight'], ['theme','theme'], ['density','density'], ['tool-view','toolView'],
                           ['sort-order','sort'], ['source-filter','source']]) {
    const el = $('#' + id);
    if (el && el.value !== String(settings[key])) el.value = settings[key];
  }
  for (const id of ['reminders', 'timestamps', 'tokens']) $('#' + id).checked = settings[id];
  $('#font-size-out').value = settings.fontSize + 'px';
  $('#width-out').value = settings.lineWidth + 'ch';
  $('#height-out').value = (settings.lineHeight / 10).toFixed(1);
  $('#focus-button').setAttribute('aria-pressed', settings.focus);
  $('#split-button').setAttribute('aria-pressed', settings.split);
  $('#follow-button').setAttribute('aria-pressed', settings.following);
  $('#follow-button').textContent = settings.following ? 'Following' : 'Follow off';
  $('#split-reader').hidden = !settings.split;
  save();
}

/* ----------------------------------------------------------------- markdown */
const SENTINEL = /^\u0000\d+\u0000$/;
const BLOCK_START = /^(\s*([-*+]|\d+[.)])\s+|#{1,6}\s|\s*&gt;|\s*\||\u0000\d+\u0000$|(-{3,}|\*{3,}|_{3,})\s*$)/;

/** A small, forgiving subset of Markdown: enough for transcripts, no library. */
function markdown(src){
  if (!src) return '';
  const stash = [];
  const keep = html => '\u0000' + (stash.push(html) - 1) + '\u0000';
  let s = esc(src);

  // Fenced code first, so nothing inside it is treated as markup.
  s = s.replace(/```([^\n`]*)\n([\s\S]*?)(?:\n```|$)/g, (_, lang, code) =>
    keep(`<pre${lang.trim() ? ` data-lang="${lang.trim()}"` : ''}><code>${code}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));

  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
       .replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
       .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(?<![\w*])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*(?![\w*])/g, '<em>$1</em>')
       .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  const lines = s.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {i++; continue}
    if (SENTINEL.test(line.trim())) {out.push(line.trim()); i++; continue}
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {out.push('<hr>'); i++; continue}
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {const n = heading[1].length; out.push(`<h${n}>${heading[2]}</h${n}>`); i++; continue}
    if (/^\s*&gt;/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${quoted.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {i = list(lines, i, out); continue}
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const after = table(lines, i, out);
      if (after > i) {i = after; continue}
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) para.push(lines[i++]);
    if (!para.length) {out.push('<p>' + lines[i] + '</p>'); i++; continue}
    out.push('<p>' + para.join('<br>') + '</p>');
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, n) => stash[n]);

  function list(lines, i, out){
    const stack = [];
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (!m) break;
      const indent = m[1].replace(/\t/g, '  ').length;
      const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
      let text = m[3];
      const task = text.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) text = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}>${task[2]}`;
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) close(stack.pop(), out);
      if (!stack.length || indent > stack[stack.length - 1].indent) {
        // A nested list belongs inside the item above it, so reopen that <li>.
        const nested = stack.length > 0;
        if (nested && out[out.length - 1].endsWith('</li>')) out[out.length - 1] = out[out.length - 1].slice(0, -5);
        stack.push({indent, tag, nested});
        out.push('<' + tag + '>');
      }
      out.push('<li>' + text + '</li>');
      i++;
      // One blank line between items does not close the list.
      if (i < lines.length && !lines[i].trim() && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1] || '')) i++;
    }
    while (stack.length) close(stack.pop(), out);
    return i;
  }

  function close(level, out){
    out.push('</' + level.tag + '>' + (level.nested ? '</li>' : ''));
  }

  function table(lines, i, out){
    const rows = [];
    let j = i;
    while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) rows.push(lines[j++].trim());
    if (rows.length < 2) return i;
    const cells = row => row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const rule = cells(rows[1]);
    if (!rule.length || !rule.every(c => /^:?-{2,}:?$/.test(c))) return i;
    const align = rule.map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left');
    const cell = (value, n, tag) => `<${tag} style="text-align:${align[n] || 'left'}">${value}</${tag}>`;
    const head = cells(rows[0]).map((v, n) => cell(v, n, 'th')).join('');
    const body = rows.slice(2).map(r => '<tr>' + cells(r).map((v, n) => cell(v, n, 'td')).join('') + '</tr>').join('');
    out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    return j;
  }
}

/* -------------------------------------------------------------------- tools */
const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description', 'cmd', 'input', 'content'];

function textContent(content){
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n');
}
function toolName(name){
  if (name && name.startsWith('mcp__')) {
    const parts = name.split('__');
    return `${parts[1] || 'mcp'}: ${(parts.slice(2).join(' ') || 'tool').replaceAll('_', ' ')}`;
  }
  return name || 'tool';
}
function argSummary(input){
  if (!input || typeof input !== 'object') return oneLine(input);
  for (const key of ARG_KEYS) if (typeof input[key] === 'string' && input[key].trim()) return oneLine(input[key]);
  return Object.keys(input).length ? oneLine(JSON.stringify(input)) : '';
}
function resultText(result){
  let out = result && result.content !== undefined ? result.content : '';
  if (Array.isArray(out)) out = out.map(x => (x && x.text) || (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  return String(out ?? '');
}
function resultHTML(result){
  if (!result) return '<span class="pending">Awaiting result…</span>';
  const full = resultText(result);
  const clipped = full.length > 3000;
  return `<p class="label${result.is_error ? ' err' : ''}">${result.is_error ? 'Error' : 'Result'}`
    + '<button class="copy-out" type="button">Copy</button></p>'
    + `<pre>${esc(clipped ? full.slice(0, 3000) : full)}</pre>`
    + (clipped ? `<template class="full-output">${esc(full)}</template>`
                 + `<button class="show-all" type="button">Show all ${compact(full.length)} characters</button>` : '');
}
function toolHTML(block, result, i){
  const command = settings.toolView === 'full'
    ? `<p class="label">Input</p><pre>${esc(JSON.stringify(block.input || {}, null, 2))}</pre>` : '';
  return `<details class="tool${result && result.is_error ? ' error' : ''}" data-i="${i}" data-tool="${esc(block.id || '')}">`
    + `<summary><span class="tool-name">${esc(toolName(block.name))}</span>`
    + `<span class="tool-arg">${esc(argSummary(block.input))}</span></summary>`
    + `<div class="tool-body">${command}<div class="tool-result">${resultHTML(result)}</div></div></details>`;
}

/* -------------------------------------------------------------------- panes */
function makePane(name, scroller, root, buttons){
  return {name, scroller: $(scroller), root: $(root), buttons, session: null, records: [], results: new Map(),
          pending: new Set(), rendered: 0, next: null, cursor: null, start: 0, busy: false, tailRequest: null};
}
const main = makePane('main', '#reader', '#transcript', {more: '#load-more', all: '#load-all', earlier: '#load-earlier'});
const side = makePane('side', '#split-reader', '#split-transcript', {more: '#split-load-more', all: '#split-load-all'});
const panes = [main, side];

function resetPane(pane, session){
  pane.session = session; pane.records = []; pane.results = new Map(); pane.pending = new Set();
  pane.rendered = 0; pane.next = null; pane.cursor = null; pane.start = 0; pane.lastTurnId = null; pane.tailRequest = null;
  pane.root.innerHTML = '';
}

function indexResults(pane, records){
  for (const record of records) {
    const content = record.message && record.message.content;
    if (record.type !== 'user' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_result' && !pane.results.has(block.tool_use_id)) {
        pane.results.set(block.tool_use_id, block);
      }
    }
  }
}

/**
 * Fill in tool cards that were rendered before their result had been read.
 * Only cards still waiting are touched — everything else already rendered with its result.
 */
function patchResults(pane){
  if (!pane.pending.size) return;
  for (const id of [...pane.pending]) {
    const result = pane.results.get(id);
    if (!result) continue;
    pane.pending.delete(id);
    const el = pane.root.querySelector(`.tool[data-tool="${CSS.escape(id)}"]`);
    if (!el) continue;
    el.classList.toggle('error', !!result.is_error);
    el.querySelector('.tool-result').innerHTML = resultHTML(result);
  }
}

/** Harness plumbing that arrives as a user message but nobody typed. */
const SCAFFOLD = /^\s*(<system-reminder>|<environment_context>|<user_instructions>|<command-name>|<local-command-stdout>|<command-message>|Caveat: The messages below)/i;

const isBookkeeping = record => record && record.type !== 'user' && record.type !== 'assistant';
/** One assistant response is written as several records sharing a message id. */
const sameTurn = (a, b) => !!(a && b && a.type === 'assistant' && b.type === 'assistant'
  && a.message && b.message && a.message.id && a.message.id === b.message.id);

function recordHTML(pane, record, i){
  const type = record.type, message = record.message || {}, content = message.content;
  const offset = record._offset != null ? ` data-offset="${record._offset}"` : '';
  const stamp = settings.timestamps && record.timestamp ? `<span class="stamp">${esc(fmtTime(record.timestamp))}</span>` : '';
  const attrs = ` data-pane="${pane.name}" data-i="${i}"${offset}`;
  if (settings.focus && record.isSidechain) return '';

  if (type !== 'assistant') pane.lastTurnId = null;

  if (type === 'user') {
    const text = textContent(content);
    if (text.includes('[Request interrupted by user')) return `<div class="interruption"${attrs}><span>Request interrupted</span></div>`;
    if (!text.trim()) return '';
    if (SCAFFOLD.test(text) && !settings.reminders) return '';
    return `<article class="turn user" tabindex="-1"${attrs}>`
      + `<div class="turn-head"><span class="who">You</span>${stamp}`
      + `<span class="turn-actions"><button data-copy="${i}" type="button">Copy</button></span></div>`
      + `<div class="message">${markdown(text)}</div></article>`;
  }

  if (type === 'assistant') {
    const blocks = Array.isArray(content) ? content : [];
    const prose = blocks.filter(x => x.type === 'text').map(x => x.text || '').join('\n');
    if (settings.focus && !prose.trim()) return '';
    const tools = settings.focus ? '' : blocks.filter(x => x.type === 'tool_use').map(x => {
      const result = pane.results.get(x.id);
      if (!result && x.id) pane.pending.add(x.id);
      return toolHTML(x, result, i);
    }).join('');
    if (!prose.trim() && !tools) return '';
    const continues = !!(message.id && message.id === pane.lastTurnId);
    pane.lastTurnId = message.id || null;
    let last = i;
    while (sameTurn(pane.records[last], pane.records[last + 1])) last++;
    const usage = message.usage || {};
    const counted = usage.input_tokens || usage.output_tokens || usage.cache_read_input_tokens || usage.cache_creation_input_tokens;
    const tokens = settings.tokens && !settings.focus && counted && last === i
      ? `<div class="token-note">${compact(usage.input_tokens)} in · ${compact(usage.output_tokens)} out · `
        + `cache ${compact(usage.cache_read_input_tokens)} read / ${compact(usage.cache_creation_input_tokens)} write</div>` : '';
    const model = message.model ? `<span class="stamp">${esc(modelName(message.model))}</span>` : '';
    const head = continues ? '' : `<div class="turn-head"><span class="who">Assistant</span>${model}${stamp}`
      + `<span class="turn-actions"><button data-copy="${i}" type="button">Copy</button></span></div>`;
    return `<article class="turn assistant${continues ? ' cont' : ''}" tabindex="-1"${attrs}>${head}`
      + (prose.trim() ? `<div class="message">${markdown(prose)}</div>` : '') + tools + tokens + '</article>';
  }

  // One marker stands in for a whole run of bookkeeping records.
  if (settings.focus || isBookkeeping(pane.records[i - 1])) return '';
  const run = pane.records.slice(i).findIndex(r => !isBookkeeping(r));
  const span = run < 0 ? pane.records.length - i : run;
  return `<div class="bookkeeping"${attrs} title="${span} bookkeeping record${span === 1 ? '' : 's'}"></div>`;
}

function render(pane, full){
  if (full) {pane.root.innerHTML = ''; pane.rendered = 0; pane.lastTurnId = null; pane.pending.clear()}
  let html = '';
  for (let i = pane.rendered; i < pane.records.length; i++) html += recordHTML(pane, pane.records[i], i);
  if (html) pane.root.insertAdjacentHTML('beforeend', html);
  pane.rendered = pane.records.length;
  updateButtons(pane);
  if (pane === main) buildOutline();
}

function updateButtons(pane){
  const {more, all, earlier} = pane.buttons;
  $(more).hidden = !pane.next;
  $(all).hidden = !pane.next;
  if (earlier) $(earlier).hidden = !(pane.session && pane.start > 0);
}

/** Merge a fetched page into a pane, keeping the scroll position stable. */
function absorb(pane, data, {prepend = false} = {}){
  const records = (data.records || []).filter(r => !prepend || r._offset < pane.start);
  indexResults(pane, records);
  if (prepend) {
    const before = pane.scroller.scrollHeight, top = pane.scroller.scrollTop;
    pane.records.unshift(...records);
    pane.start = data.start || 0;
    render(pane, true);
    pane.scroller.scrollTop = top + (pane.scroller.scrollHeight - before);
  } else {
    pane.records.push(...records);
    pane.next = data.next;
    pane.cursor = data.cursor;
    render(pane, false);
    patchResults(pane);
  }
  return records.length;
}

/* ------------------------------------------------------------------ loading */
async function openSession(id, {pane = main, offset = null, focus = null} = {}){
  if (pane.busy) return;
  pane.busy = true;
  try {
    if (offset == null && pane === main) offset = +localStorage.getItem('csv-position-' + id) || 0;
    const data = await api(`/api/session?id=${encodeURIComponent(id)}${offset ? '&offset=' + offset : ''}`);
    resetPane(pane, data.session);
    pane.start = data.start || 0;
    absorb(pane, data);
    if (pane === main) {
      history.replaceState(null, '', `?session=${encodeURIComponent(id)}`);
      $('#empty').hidden = true;
      describeSession(data);
    } else {
      $('#split-meta').innerHTML = `<span class="source-tag ${esc((data.session.source || '').toLowerCase())}">${esc(data.session.source || 'Unknown')}</span> ${esc(sessionTitle(data.session))}`;
    }
    markActive();
    document.body.classList.remove('library-open');
    if (focus != null) highlight(pane, focus); else pane.scroller.scrollTop = 0;
  } catch (err) {
    toast('Could not open that session: ' + err.message, 'error');
  } finally {
    pane.busy = false;
  }
}

function describeSession(data){
  const s = data.session, u = s.usage || {};
  $('#session-title').innerHTML = `<span id="session-source" class="source-tag ${esc((s.source || '').toLowerCase())}">${esc(s.source || 'Unknown')}</span>${esc(sessionTitle(s))}`;
  const bits = [s.cwd, s.branch || 'no branch', `${s.count} records`];
  if (s.tools) bits.push(`${s.tools} tool calls`);
  const models = (s.models || []).filter(m => !m.startsWith('<'));
  if (models.length) bits.push(models.map(modelName).join(', '));
  if (u.input || u.output) bits.push(`${compact(u.input)} in · ${compact(u.output)} out · cache ${compact(u.cacheRead)}/${compact(u.cacheWrite)}`);
  if (data.malformed) bits.push(`${data.malformed} malformed skipped`);
  $('#session-meta').textContent = bits.join(' · ');
  document.title = s.title + ' — Session Viewer';
}

function highlight(pane, offset){
  const el = pane.root.querySelector(`[data-offset="${offset}"]`) || pane.root.firstElementChild;
  if (!el) return;
  el.scrollIntoView({block: 'center'});
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

async function loadMore(pane, limit){
  if (!pane.session || !pane.next || pane.busy) return;
  const session = pane.session, from = pane.next;
  pane.busy = true;
  try {
    const url = `/api/session?id=${encodeURIComponent(session.id)}&offset=${from}`;
    const data = await api(limit ? `${url}&limit=${limit}` : url);
    // A tail request may have advanced this cursor while the manual page was
    // in flight.  Only the response that still matches this exact page wins.
    if (pane.session === session && pane.cursor === from) absorb(pane, data);
  } catch (err) {
    toast('Could not load more records: ' + err.message, 'error');
  } finally {pane.busy = false}
}

async function loadEarlier(pane){
  if (!pane.session || !pane.start || pane.busy) return;
  pane.busy = true;
  try {
    absorb(pane, await api(`/api/session?id=${encodeURIComponent(pane.session.id)}&before=${pane.start}`), {prepend: true});
  } catch (err) {
    toast('Could not load earlier records: ' + err.message, 'error');
  } finally {pane.busy = false}
}

async function loadAll(pane){
  if (!pane.session || !pane.next) return;
  const button = $(pane.buttons.all), id = pane.session.id;
  button.disabled = true;
  try {
    while (pane.next && pane.session && pane.session.id === id) {
      button.textContent = `Loading… ${pane.records.length} records`;
      const from = pane.next;
      await loadMore(pane, 500);   // fewer, larger pages than a manual click
      if (pane.next === from) break;                    // no progress: stop rather than spin
      await new Promise(done => setTimeout(done, 0));   // yield without depending on a paint
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Load entire session';
  }
}

async function tail(){
  if (!settings.following || document.hidden) return;
  for (const pane of panes) {
    if (!pane.session || pane.cursor == null || pane.busy || pane.tailRequest) continue;
    const scroller = pane.scroller;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    // A paginated reader has more existing history to load.  Only advance one
    // page automatically when the reader is already at its bottom; otherwise
    // follow only once the rendered cursor has caught up to EOF.
    if (pane.next && !atBottom) continue;
    const session = pane.session, from = pane.cursor, request = {};
    pane.tailRequest = request;
    try {
      const data = await api(`/api/tail?id=${encodeURIComponent(session.id)}&offset=${from}`);
      // A reopen creates a fresh session object; a concurrent manual page load
      // advances the cursor.  Either makes this response stale.
      if (pane.session === session && pane.cursor === from && absorb(pane, data) && atBottom && !data.next) {
        scroller.scrollTo({top: scroller.scrollHeight, behavior: 'smooth'});
      }
    } catch (err) { /* the file may be mid-write; the next tick retries */ }
    finally {
      if (pane.tailRequest === request) pane.tailRequest = null;
    }
  }
}

/* ------------------------------------------------------------------ library */
function sortSessions(list){
  const by = {
    recent: (a, b) => String(b.end || '').localeCompare(String(a.end || '')),
    oldest: (a, b) => String(a.start || '').localeCompare(String(b.start || '')),
    turns: (a, b) => b.count - a.count,
    size: (a, b) => b.size - a.size,
  }[settings.sort];
  return by ? [...list].sort(by) : list;
}

function matches(session){
  if (settings.source && (session.source || 'Claude') !== settings.source) return false;
  if (settings.project && session.cwd !== settings.project) return false;
  const meta = savedFor(session.id);
  if (state.savedFilter === 'starred' && !meta.star) return false;
  if (state.savedFilter === 'tagged' && !(meta.tags || '').trim()) return false;
  if (!state.filter) return true;
  return `${sessionTitle(session)} ${session.cwd} ${session.branch || ''} ${meta.tags || ''} ${meta.note || ''}`.toLowerCase().includes(state.filter.toLowerCase());
}

function mark(text){
  if (!state.filter) return esc(text);
  const at = text.toLowerCase().indexOf(state.filter.toLowerCase());
  if (at < 0) return esc(text);
  const end = at + state.filter.length;
  return esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, end)) + '</mark>' + esc(text.slice(end));
}

function renderLibrary(){
  const visible = sortSessions(state.sessions.filter(matches));
  $('#session-count').textContent = visible.length === state.sessions.length
    ? `${state.sessions.length} sessions`
    : `${visible.length} of ${state.sessions.length} sessions`;

  const groups = new Map();
  for (const s of visible) {
    const key = s.cwd || s.project;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const shelf = $('#library'), place = shelf.scrollTop;
  $('#session-list').innerHTML = visible.length === 0
    ? '<p class="empty-list">No sessions match these filters.</p>'
    : [...groups].map(([project, list]) =>
        `<section class="project"><div class="project-name" title="${esc(project)}">${mark(project)}</div>`
        + list.map(s => `<a class="session" data-id="${esc(s.id)}" href="?session=${encodeURIComponent(s.id)}" title="${esc(s.title)}">`
          + `<span class="session-title">${savedFor(s.id).star ? '★ ' : ''}${mark(sessionTitle(s))}</span><span class="session-info">`
          + `<span class="badge ${esc((s.source || 'claude').toLowerCase())}">${esc(s.source || 'Claude')}</span>`
          + `<span>${esc(relTime(s.end || s.start))}</span><span>${s.count} turns</span>`
          + ((savedFor(s.id).tags || '').trim() ? `<span class="saved-tags">${esc(savedFor(s.id).tags)}</span>` : '')
          + (duration(s.start, s.end) ? `<span>${duration(s.start, s.end)}</span>` : '')
          + `<span>${size(s.size)}</span>${s.branch ? `<span>${esc(s.branch)}</span>` : ''}</span></a>`).join('')
        + '</section>').join('');
  shelf.scrollTop = place;
  markActive();
}

function markActive(){
  for (const link of $$('#session-list .session')) {
    const active = (main.session && main.session.id === link.dataset.id)
                || (side.session && side.session.id === link.dataset.id);
    link.classList.toggle('active', !!active);
  }
}

function fillProjects(){
  const select = $('#project-filter');
  const projects = [...new Set(state.sessions.map(s => s.cwd || s.project))].sort();
  select.innerHTML = '<option value="">All projects</option>'
    + projects.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  select.value = projects.includes(settings.project) ? settings.project : '';
  settings.project = select.value;
}

let indexSignature = '', indexFailed = false;
async function loadIndex(force){
  try {
    const data = await api('/api/index' + (force ? '?refresh=1' : ''));
    state.sessions = data.sessions;
    const signature = data.sessions.length + ':' + data.sessions.map(s => s.id + s.mtime).join();
    if (signature !== indexSignature) {
      indexSignature = signature;
      fillProjects();
      renderLibrary();
    }
    const requested = new URLSearchParams(location.search).get('session');
    if (requested && !main.session && data.sessions.some(s => s.id === requested)) openSession(requested);
    indexFailed = false;
  } catch (err) {
    $('#session-count').textContent = 'Archive unavailable';
    if (!indexFailed) toast('Could not reach the viewer server: ' + err.message, 'error');
    indexFailed = true;   // the poller retries quietly until it comes back
  }
}

/* ------------------------------------------------------------------ outline */
function buildOutline(){
  if (!main.session) return;
  const items = [];
  main.records.forEach((record, i) => {
    if (record.type !== 'user') return;
    const text = textContent(record.message && record.message.content);
    if (!text.trim() || text.includes('[Request interrupted by user') || SCAFFOLD.test(text)) return;
    items.push({i, text: oneLine(text, 90), stamp: record.timestamp});
  });
  $('#tab-outline').innerHTML = items.length
    ? items.map(item => `<button class="outline-item" data-goto="${item.i}" type="button">`
        + `<b>${esc(relTime(item.stamp) || 'turn')}</b>${esc(item.text)}</button>`).join('')
    : '<p class="hint">No prompts among the records loaded so far.</p>';
}

function jumpTo(i){
  const el = main.root.querySelector(`.turn[data-i="${i}"]`);
  if (!el) return;
  el.scrollIntoView({block: 'start'});
  selectRecord(main, i);
}

/* ---------------------------------------------------------------- selection */
function selectRecord(pane, i){
  state.selected = {pane, i};
  $$('.turn.selected, .tool.selected').forEach(el => el.classList.remove('selected'));
  const el = pane.root.querySelector(`[data-i="${i}"]`);
  if (el) el.classList.add('selected');
  $('#raw-json').textContent = JSON.stringify(pane.records[i], null, 2);
}

function copyTurn(pane, i){
  const record = pane.records[i];
  const text = textContent(record && record.message && record.message.content);
  navigator.clipboard.writeText(text).then(() => toast('Turn copied as Markdown'), () => toast('Clipboard blocked', 'error'));
}

/* ------------------------------------------------------------------- search */
let searchTimer, searchAbort;
function runSearch(){
  const query = $('#search-input').value.trim();
  clearTimeout(searchTimer);
  if (query.length < 2) {
    $('#search-results').innerHTML = '';
    $('#search-status').textContent = query ? 'Type at least two characters.' : '';
    return;
  }
  searchTimer = setTimeout(async () => {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    $('#search-status').textContent = 'Searching…';
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}&role=${$('#search-role').value}`,
                             {signal: searchAbort.signal});
      $('#search-status').textContent = data.total
        ? `${data.total}${data.capped ? '+' : ''} matches across ${data.groups.length} sessions`
        : 'No matches.';
      $('#search-results').innerHTML = data.groups.map(group =>
        `<div class="result-group"><h3>${esc(group.title)}<small>${esc(group.cwd)}</small></h3>`
        + group.hits.map(hit => `<button class="result" type="button" data-id="${esc(group.id)}" data-offset="${hit.offset}">`
          + `<span>${hit.role === 'user' ? 'You' : 'Assistant'} · ${esc(relTime(hit.timestamp) || group.source)}</span>`
          + `<small>${esc(hit.text)}</small></button>`).join('')
        + '</div>').join('');
    } catch (err) {
      if (err.name !== 'AbortError') $('#search-status').textContent = 'Search failed: ' + err.message;
    }
  }, 220);
}

/* -------------------------------------------------------------------- share */
/** One click: open the panel, start the LAN listener, show the code to scan. */
async function openShare(){
  openPanel('share-panel');
  $('#share-status').textContent = 'Starting…';
  $('#share-status').classList.remove('bad');
  $('#share-qr').innerHTML = '';
  $('#share-url').textContent = '';
  await callShare('/api/share/start');
}

async function callShare(url){
  try {
    showShare(await api(url, {method: url === '/api/share' ? 'GET' : 'POST'}));
  } catch (err) {
    $('#share-status').textContent = 'Sharing failed: ' + err.message;
    $('#share-status').classList.add('bad');
  }
}

function showShare(state){
  const status = $('#share-status');
  if (state.remote) {$('#share-button').hidden = true; return}   // this page *is* the shared one
  status.classList.toggle('bad', !!state.error);
  $('#share-button').setAttribute('aria-pressed', !!state.enabled);
  $('#share-stop').hidden = !state.enabled;
  $('#share-copy').hidden = !state.url;
  if (state.error) {
    status.textContent = state.error;
    $('#share-qr').innerHTML = '';
    $('#share-url').textContent = '';
    return;
  }
  if (!state.enabled) {
    status.textContent = 'Sharing is off.';
    $('#share-qr').innerHTML = '';
    $('#share-url').textContent = '';
    return;
  }
  status.textContent = 'Live on your network — scan to open.';
  $('#share-qr').innerHTML = state.qr || '';        // SVG generated by this server
  $('#share-url').textContent = state.url;
  $('#share-url').href = state.url;
}

/* ------------------------------------------------------------------- panels */
function openPanel(id){
  $$('.panel').forEach(p => {if (p.id !== id) p.classList.add('closed')});
  $('#' + id).classList.remove('closed');
}
const closeAll = () => $$('.panel').forEach(p => p.classList.add('closed'));
const togglePanel = id => $('#' + id).classList.contains('closed') ? openPanel(id) : closeAll();

function toggleSplit(on){
  settings.split = on;
  if (!on) resetPane(side, null);
  applySettings();
  markActive();
}

/* ------------------------------------------------------------------- events */
$('#home').onclick = () => {
  history.replaceState(null, '', location.pathname);
  resetPane(main, null);
  $('#empty').hidden = false;
  $('#session-title').textContent = 'Choose a transcript to begin';
  $('#session-meta').textContent = '';
  $('#tab-outline').innerHTML = '<p class="hint">Turns in this session appear here once a transcript is open.</p>';
  document.title = 'Session Viewer';
  updateButtons(main);
  markActive();
};
$('#refresh').onclick = () => {loadIndex(true); toast('Rescanning transcripts…')};
$('#load-more').onclick = () => loadMore(main);
$('#load-all').onclick = () => loadAll(main);
$('#load-earlier').onclick = () => loadEarlier(main);
$('#split-load-more').onclick = () => loadMore(side);
$('#split-load-all').onclick = () => loadAll(side);
$('#split-close').onclick = () => toggleSplit(false);
$('#export-button').onclick = () => {
  if (!main.session) return toast('Open a session first');
  location.href = '/api/export?id=' + encodeURIComponent(main.session.id);
};
$('#outline-button').onclick = () => {
  const closed = $('#details').classList.toggle('closed');
  $('#outline-button').setAttribute('aria-pressed', !closed);
};
function buildInsights(){
  if (!main.session) return '<p class="hint">Open a session to see its activity.</p>';
  const records = main.records, tools = [], files = new Set(); let errors = 0, prompts = 0, replies = 0;
  for (const r of records) {
    if (r.type === 'user') prompts++;
    if (r.type === 'assistant') replies++;
    for (const block of r.message?.content || []) if (block.type === 'tool_use') {
      tools.push(toolName(block.name)); const path = block.input?.file_path || block.input?.path;
      if (path) files.add(path);
    }
    if (/\b(error|failed|exception)\b/i.test(textContent(r.message?.content))) errors++;
  }
  const uniqueTools = [...new Set(tools)];
  const command = resumeCommand(main.session);
  return `<div class="insight-grid"><div><b>${prompts}</b><span>prompts</span></div><div><b>${replies}</b><span>responses</span></div><div><b>${tools.length}</b><span>tool calls</span></div><div><b>${errors}</b><span>error mentions</span></div></div>`
    + `<section class="insight-section"><b>Tools used</b><p>${uniqueTools.length ? esc(uniqueTools.join(', ')) : 'No tool calls in loaded records.'}</p></section>`
    + `<section class="insight-section"><b>Files touched</b><p>${files.size ? esc([...files].slice(0, 12).join('\n')) : 'No file paths found in loaded tool inputs.'}</p></section>`
    + `<section class="insight-section"><b>Session duration</b><p>${esc(duration(main.session.start, main.session.end) || 'Unavailable')} · ${main.session.tools || 0} total tool calls</p></section>`
    + (command ? `<section class="insight-section resume-command"><b>Resume command</b><div><code>${esc(command)}</code><button type="button" data-resume-copy="${esc(command)}">Copy</button></div></section>` : '');
}
$('#insights-button').onclick = () => {$('#insights-body').innerHTML = buildInsights(); togglePanel('insights')};
function openOrganize(){
  if (!main.session) return toast('Open a session first');
  const data = savedFor(main.session.id);
  $('#saved-title').value = data.title || ''; $('#saved-tags').value = data.tags || '';
  $('#saved-note').value = data.note || ''; $('#saved-star').checked = !!data.star; openPanel('organize');
}
$('#organize-button').onclick = openOrganize;
$('#saved-save').onclick = () => {
  if (!main.session) return;
  saved[main.session.id] = {title: $('#saved-title').value.trim(), tags: $('#saved-tags').value.trim(), note: $('#saved-note').value.trim(), star: $('#saved-star').checked};
  saveSaved(); describeSession({session: main.session, malformed: 0}); renderLibrary(); closeAll(); toast('Saved locally');
};
$('#saved-clear').onclick = () => {if (!main.session) return; delete saved[main.session.id]; saveSaved(); openOrganize(); renderLibrary(); describeSession({session: main.session, malformed: 0}); toast('Saved details cleared')};
$('#share-button').onclick = () => $('#share-panel').classList.contains('closed') ? openShare() : closeAll();
$('#share-stop').onclick = () => callShare('/api/share/stop');
$('#share-copy').onclick = () => navigator.clipboard.writeText($('#share-url').textContent)
  .then(() => toast('Link copied'), () => toast('Clipboard blocked', 'error'));
$('#controls-button').onclick = () => togglePanel('controls');
$('#help-button').onclick = () => togglePanel('help');
$('#search-button').onclick = () => {openPanel('search-panel'); $('#search-input').focus(); $('#search-input').select()};
$('#focus-button').onclick = () => {settings.focus = !settings.focus; applySettings(); panes.forEach(p => render(p, true))};
$('#follow-button').onclick = () => {settings.following = !settings.following; applySettings()};
$('#split-button').onclick = () => toggleSplit(!settings.split);
$('#library-toggle').onclick = () => {
  const open = document.body.classList.toggle('library-open');
  $('#library-toggle').setAttribute('aria-expanded', open);
};
$$('[data-close]').forEach(b => b.onclick = () => $('#' + b.dataset.close).classList.add('closed'));

$$('.tab').forEach(tab => tab.onclick = () => {
  $$('.tab').forEach(t => {t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab)});
  $('#tab-outline').hidden = tab.dataset.tab !== 'outline';
  $('#tab-raw').hidden = tab.dataset.tab !== 'raw';
});

for (const [id, key, numeric] of [['font-size','fontSize',true], ['font-family','fontFamily',false],
                                  ['line-width','lineWidth',true], ['line-height','lineHeight',true],
                                  ['theme','theme',false], ['density','density',false]]) {
  $('#' + id).oninput = e => {settings[key] = numeric ? +e.target.value : e.target.value; applySettings()};
}
$('#tool-view').oninput = e => {settings.toolView = e.target.value; applySettings(); panes.forEach(p => render(p, true))};
for (const id of ['reminders', 'timestamps', 'tokens']) {
  $('#' + id).onchange = e => {settings[id] = e.target.checked; applySettings(); panes.forEach(p => render(p, true))};
}
for (const [id, key] of [['sort-order','sort'], ['source-filter','source'], ['project-filter','project']]) {
  $('#' + id).onchange = e => {settings[key] = e.target.value; save(); renderLibrary()};
}
$('#saved-filter').onchange = e => {state.savedFilter = e.target.value; renderLibrary()};
$('#library-filter').oninput = e => {state.filter = e.target.value.trim(); renderLibrary()};
$('#search-input').oninput = runSearch;
$('#search-role').onchange = runSearch;

/* One delegated listener covers every list, transcript and tool interaction. */
document.addEventListener('click', event => {
  const link = event.target.closest('#session-list .session');
  if (link) {
    event.preventDefault();
    // Shift/⌘-click always compares; with split open and the second pane empty, a plain click fills it.
    const forced = event.shiftKey || event.metaKey || event.ctrlKey;
    const toSide = forced || (settings.split && !side.session && main.session && main.session.id !== link.dataset.id);
    if (forced && !settings.split) toggleSplit(true);
    openSession(link.dataset.id, {pane: toSide ? side : main});
    return;
  }
  const result = event.target.closest('.result');
  if (result) {
    openSession(result.dataset.id, {offset: +result.dataset.offset, focus: +result.dataset.offset});
    closeAll();
    return;
  }
  const outline = event.target.closest('.outline-item');
  if (outline) {
    $$('.outline-item').forEach(item => item.classList.toggle('current', item === outline));
    jumpTo(+outline.dataset.goto);
    return;
  }
  const showAll = event.target.closest('.show-all');
  if (showAll) {
    const body = showAll.closest('.tool-result');
    body.querySelector('pre').textContent = body.querySelector('.full-output').content.textContent;
    body.querySelector('.full-output').remove();
    showAll.remove();
    return;
  }
  const copyOut = event.target.closest('.copy-out');
  if (copyOut) {
    navigator.clipboard.writeText(copyOut.closest('.tool-result').querySelector('pre').textContent)
      .then(() => toast('Output copied'), () => toast('Clipboard blocked', 'error'));
    return;
  }
  const resumeCopy = event.target.closest('[data-resume-copy]');
  if (resumeCopy) {
    navigator.clipboard.writeText(resumeCopy.dataset.resumeCopy)
      .then(() => toast('Resume command copied'), () => toast('Clipboard blocked', 'error'));
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    copyTurn(copy.closest('[data-pane]').dataset.pane === 'side' ? side : main, +copy.dataset.copy);
    return;
  }
  const record = event.target.closest('.turn, .tool, .bookkeeping');
  if (record && !event.target.closest('button, a') && !String(getSelection())) {
    const holder = record.closest('[data-pane]');
    selectRecord(holder && holder.dataset.pane === 'side' ? side : main, +record.dataset.i);
  }
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape') {e.target.blur(); closeAll()}
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const keys = {
    '/': () => $('#search-button').click(),
    '?': () => $('#help-button').click(),
    f: () => $('#focus-button').click(),
    s: () => $('#split-button').click(),
    a: () => $('#controls-button').click(),
    e: () => $('#export-button').click(),
    m: () => $('#share-button').click(),
    r: () => $('#refresh').click(),
    t: () => {settings.theme = {auto: 'light', light: 'dark', dark: 'auto'}[settings.theme]; applySettings(); toast('Theme: ' + settings.theme)},
    g: () => main.scroller.scrollTo({top: 0, behavior: 'smooth'}),
    G: () => main.scroller.scrollTo({top: main.scroller.scrollHeight, behavior: 'smooth'}),
    Escape: () => {closeAll(); $('#details').classList.add('closed'); $('#outline-button').setAttribute('aria-pressed', false)},
    o: () => $('#outline-button').click(),
    '+': () => {settings.fontSize = Math.min(24, settings.fontSize + 1); applySettings()},
    '=': () => {settings.fontSize = Math.min(24, settings.fontSize + 1); applySettings()},
    '-': () => {settings.fontSize = Math.max(13, settings.fontSize - 1); applySettings()},
  };
  if (keys[e.key]) {e.preventDefault(); return keys[e.key]()}
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    const turns = [...main.root.querySelectorAll('.turn')];
    if (!turns.length) return;
    const current = state.selected && state.selected.pane === main ? state.selected.i : -1;
    let at = turns.findIndex(t => +t.dataset.i === current);
    at = Math.max(0, Math.min(turns.length - 1, at + (e.key === 'j' ? 1 : -1)));
    turns[at].scrollIntoView({block: 'center'});
    selectRecord(main, +turns[at].dataset.i);
  }
});

/* Remember the reading position, drive the progress bar, follow the outline. */
let scrollTick;
main.scroller.addEventListener('scroll', () => {
  const el = main.scroller;
  const span = el.scrollHeight - el.clientHeight;
  $('#progress-bar').style.width = (span > 0 ? Math.min(100, (el.scrollTop / span) * 100) : 0) + '%';
  if (scrollTick || !main.session) return;
  scrollTick = setTimeout(() => {
    scrollTick = null;
    const top = [...main.root.children].find(child => child.getBoundingClientRect().bottom > 90);
    const record = top && main.records[+top.dataset.i];
    if (record && record._offset != null) localStorage.setItem('csv-position-' + main.session.id, record._offset);
    const passed = [...main.root.querySelectorAll('.turn.user')].filter(t => t.getBoundingClientRect().top < 150);
    const current = passed.length ? +passed[passed.length - 1].dataset.i : null;
    $$('.outline-item').forEach(item => item.classList.toggle('current', +item.dataset.goto === current));
  }, 200);
}, {passive: true});

/* -------------------------------------------------------------------- start */
applySettings();
loadIndex();
// Documentation-only states. They make each real UI capability capturable from
// the built-in demo archive without changing normal reader behavior.
const demoParams = new URLSearchParams(location.search);
if (demoParams.has('demo')) setTimeout(() => {
  const panel = demoParams.get('panel');
  if (panel === 'search') {openPanel('search-panel'); $('#search-input').value = 'break-even'; runSearch()}
  if (panel === 'outline') $('#outline-button').click();
  if (panel === 'raw') {$('#outline-button').click(); $('.tab[data-tab="raw"]').click(); selectRecord(main, 0)}
  if (panel === 'controls') openPanel('controls');
  if (panel === 'insights') $('#insights-button').click();
  if (panel === 'organize') $('#organize-button').click();
  if (panel === 'help') openPanel('help');
  if (panel === 'focus') $('#focus-button').click();
  if (panel === 'mobile') openShare();
  if (panel === 'split') {toggleSplit(true); openSession('demo:launch', {pane: side})}
}, 350);
api('/api/share').then(showShare).catch(() => {});
setInterval(tail, 1500);
setInterval(() => {if (!document.hidden) loadIndex()}, 20000);
