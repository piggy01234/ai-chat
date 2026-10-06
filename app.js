'use strict';
const $ = s => document.querySelector(s);
const MODELS = {
  claude: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'],
  gemini: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite']
};
const NAMES = { claude: 'Claude', gemini: 'Gemini' };
const LABELS = {
  'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'gemini-3.8-flash': 'Gemini 3.8 Flash', 'gemini-3.1-pro-preview': 'Gemini 3.1 Pro', 'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite'
};
const svg = d => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  check: svg('<path d="M5 12l5 5 9-9"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>')
};
function iconBtn(html, title) { const b = el('button', 'iconbtn'); b.innerHTML = html; b.title = title; b.setAttribute('aria-label', title); return b; }

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn(e); } }
};
const defaults = {
  provider: 'claude',
  keys: { claude: '', gemini: '' },
  models: { claude: MODELS.claude[0], gemini: MODELS.gemini[0] },
  system: '', temperature: 1, maxTokens: 16384, theme: 'light', thinking: true
};
const saved = store.get('settings', {});
const settings = { ...defaults, ...saved,
  keys: { ...defaults.keys, ...(saved.keys || {}) },
  models: { ...defaults.models, ...(saved.models || {}) } };
// one-time migration: move people still on the old default Gemini model to 3.8 Flash
if (!saved.v || saved.v < 2) {
  if (settings.models.gemini === 'gemini-2.5-flash') settings.models.gemini = MODELS.gemini[0];
  settings.v = 2; store.set('settings', settings);
}
// one-time migration: swap removed Gemini models for their replacements
const MIGRATE = { 'gemini-2.5-pro': 'gemini-3.1-pro-preview', 'gemini-2.5-flash': 'gemini-3.8-flash', 'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite' };
if ((saved.v || 0) < 5) {
  if (settings.maxTokens === 4096) settings.maxTokens = 16384; // old default caused cut-off replies
  if (MIGRATE[settings.models.gemini]) settings.models.gemini = MIGRATE[settings.models.gemini];
  settings.v = 5; store.set('settings', settings);
}
let chats = store.get('chats', []);
let currentId = store.get('currentId', null);
let abort = null;
let lastError = null;

const saveSettings = () => store.set('settings', settings);
const saveChats = () => { store.set('chats', chats); store.set('currentId', currentId); };
const current = () => chats.find(c => c.id === currentId);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------- helpers ---------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function renderMarkdown(text) {
  if (!window.marked || !window.DOMPurify) return null;
  return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
}
function fillBody(body, m, streaming) {
  if (m.role === 'user') { body.textContent = m.content; return; }
  body.innerHTML = '';
  const waiting = streaming && !m.content;
  if (m.thinking) {
    const d = el('details', 'think');
    d.open = m.thinkOpen != null ? m.thinkOpen : waiting;
    const sum = el('summary', waiting ? 'shimmer' : '', waiting ? 'Thinking…' : 'Thought process');
    sum.onclick = () => { m.thinkOpen = !d.open; };
    d.append(sum, el('div', 'think-body', m.thinking));
    body.append(d);
  } else if (waiting) {
    body.append(el('div', 'shimmer wait', 'Thinking…'));
  }
  if (m.content) {
    const ans = el('div', 'answer');
    const html = renderMarkdown(m.content);
    if (html == null) ans.textContent = m.content; else ans.innerHTML = html;
    ans.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (code && window.hljs && !streaming) { try { hljs.highlightElement(code); } catch {} }
      const b = el('button', 'copy', 'Copy');
      b.onclick = () => { navigator.clipboard.writeText(pre.innerText.replace(/Copy$/, '').trim()); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1200); };
      pre.appendChild(b);
    });
    body.append(ans);
  }
  body.classList.toggle('cursor', !!streaming && !!m.content);
}

/* ---------- rendering ---------- */
function renderSidebar() {
  const nb = $('#newChat'), cur = current();
  nb.disabled = !cur || !cur.messages.length;
  nb.title = nb.disabled ? "You're already in a new chat" : '';
  const list = $('#chatList'); list.innerHTML = '';
  [...chats].sort((a, b) => b.updated - a.updated).forEach(c => {
    const item = el('div', 'chat-item' + (c.id === currentId ? ' active' : ''));
    item.append(el('span', 't', c.title));
    const x = el('button', 'x'); x.innerHTML = ICON.x; x.title = 'Delete chat';
    x.onclick = e => { e.stopPropagation(); deleteChat(c.id); };
    item.append(x);
    item.onclick = () => { if (abort) return; const cur = current(); if (cur && cur.id !== c.id && !cur.messages.length) chats = chats.filter(x => x.id !== cur.id); currentId = c.id; lastError = null; saveChats(); renderAll(); $('#sidebar').classList.remove('open'); };
    list.append(item);
  });
}
function cutText(r) {
  if (/max_tokens/i.test(r)) return 'This reply hit the length limit and was cut off.';
  if (r === 'STREAM_ENDED') return 'The connection closed before the reply finished.';
  return `The model stopped early (${r}).`;
}
function messageEl(m, i, isLast, streaming) {
  const wrap = el('div', 'msg ' + m.role);
  const body = el('div', 'body'); fillBody(body, m, streaming); wrap.append(body);
  if (m.role === 'assistant' && !streaming) {
    const a = el('div', 'actions');
    const cp = iconBtn(ICON.copy, 'Copy');
    cp.onclick = () => { navigator.clipboard.writeText(m.content); cp.innerHTML = ICON.check; setTimeout(() => cp.innerHTML = ICON.copy, 1200); };
    a.append(cp);
    if (isLast) { const rg = iconBtn(ICON.refresh, 'Regenerate'); rg.onclick = regenerate; a.append(rg); }
    a.append(el('span', 'meta', m.model || NAMES[m.provider] || ''));
    wrap.append(a);
    if (m.cut && isLast) {
      const n = el('div', 'trunc'); n.append(el('span', null, cutText(m.cut)));
      const cb = el('button', null, 'Continue');
      cb.onclick = () => { if (abort) return; m.cut = null; current().messages.push({ role: 'user', content: 'Continue' }); saveChats(); renderSidebar(); generate(); };
      n.append(cb); wrap.append(n);
    }
  }
  return wrap;
}
function renderMessages(streamingLast) {
  const box = $('#messages'); box.innerHTML = '';
  const c = current();
  if (!c || !c.messages.length) {
    const e = el('div', 'empty');
    e.append(el('h1', null, 'How can I help you today?'), el('p', null, 'Pick Claude or Gemini at the top, add your API key in Settings, and start typing.'));
    box.append(e);
  } else {
    c.messages.forEach((m, i) => box.append(messageEl(m, i, i === c.messages.length - 1, streamingLast && i === c.messages.length - 1)));
  }
  if (lastError) {
    const e = el('div', 'err'); e.append(el('span', null, lastError));
    if (c && c.messages.length && c.messages[c.messages.length - 1].role === 'user') {
      const r = el('button', 'ghost', 'Retry'); r.onclick = () => { lastError = null; generate(); }; e.append(r);
    }
    box.append(e);
  }
  box.scrollTop = box.scrollHeight;
}
let raf = 0;
function scheduleStreamRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const c = current(); if (!c) return;
    const box = $('#messages'); const last = box.lastElementChild;
    const m = c.messages[c.messages.length - 1];
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (last && last.classList.contains('assistant')) {
      const body = last.querySelector('.body'); fillBody(body, m, true);
      if (stick) box.scrollTop = box.scrollHeight;
    } else renderMessages(true);
  });
}
const modelLabel = id => LABELS[id] || id;
function renderTopbar() {
  const p = settings.provider;
  $('#modelLabel').textContent = modelLabel(settings.models[p]);
  $('#thinkBtn').classList.toggle('on', !!settings.thinking);
  $('#thinkBtn').setAttribute('aria-pressed', String(!!settings.thinking));
  const has = !!settings.keys[p];
  $('#keyState').textContent = has ? 'API key set' : 'Add an API key in Settings';
  $('#keyState').classList.toggle('bad', !has);
}
function closeMenu() { $('#modelMenu').classList.add('hidden'); }
function pickModel(p, id) { settings.provider = p; settings.models[p] = id; saveSettings(); closeMenu(); renderTopbar(); }
function buildModelMenu() {
  const menu = $('#modelMenu'); menu.innerHTML = '';
  for (const p of ['claude', 'gemini']) {
    menu.append(el('div', 'menu-head', NAMES[p]));
    const ids = [...MODELS[p]]; const cur = settings.models[p];
    if (!ids.includes(cur)) ids.push(cur);
    ids.forEach(id => {
      const b = el('button', 'menu-item'); b.append(el('span', null, modelLabel(id)));
      if (settings.provider === p && cur === id) { const t = el('span', 'tick'); t.innerHTML = ICON.check; b.append(t); }
      b.onclick = () => pickModel(p, id);
      menu.append(b);
    });
    const inp = el('input', 'menu-input'); inp.placeholder = 'Other model ID, then Enter'; inp.spellcheck = false;
    inp.onkeydown = e => { if (e.key === 'Enter' && inp.value.trim()) pickModel(p, inp.value.trim()); };
    menu.append(inp);
  }
}
function renderAll() { renderSidebar(); renderMessages(); renderTopbar(); document.documentElement.dataset.theme = settings.theme; }
function setBusy(b) { $('#send').classList.toggle('hidden', b); $('#stop').classList.toggle('hidden', !b); }

/* ---------- chats ---------- */
function newChat() {
  if (abort) return;
  const cur = current();
  if (!cur || !cur.messages.length) { $('#input').focus(); $('#sidebar').classList.remove('open'); return; } // already in a fresh chat
  createChat();
}
function createChat() {
  if (abort) return;
  const c = { id: uid(), title: 'New chat', messages: [], updated: Date.now() };
  chats.push(c); currentId = c.id; lastError = null; saveChats(); renderAll(); $('#input').focus();
  $('#sidebar').classList.remove('open');
}
function deleteChat(id) {
  if (abort) return;
  chats = chats.filter(c => c.id !== id);
  if (currentId === id) currentId = chats.length ? chats[chats.length - 1].id : null;
  saveChats(); renderAll();
}
function exportChat() {
  const c = current(); if (!c || !c.messages.length) return;
  const md = c.messages.map(m => `### ${m.role === 'user' ? 'You' : NAMES[m.provider] || 'Assistant'}\n\n${m.content}\n`).join('\n');
  const a = el('a'); a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = c.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 40) + '.md'; a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- sending ---------- */
function send() {
  if (abort) return;
  const text = $('#input').value.trim(); if (!text) return;
  if (!current()) createChat();
  const c = current();
  c.messages.push({ role: 'user', content: text });
  if (c.title === 'New chat') c.title = text.slice(0, 40);
  c.updated = Date.now();
  $('#input').value = ''; autosize(); lastError = null;
  saveChats(); renderSidebar(); generate();
}
function regenerate() {
  const c = current(); if (!c || abort) return;
  if (c.messages.length && c.messages[c.messages.length - 1].role === 'assistant') c.messages.pop();
  lastError = null; generate();
}
async function generate() {
  const c = current(); if (!c || abort) return;
  const p = settings.provider, key = settings.keys[p], model = settings.models[p];
  if (!key) { lastError = `Add your ${p === 'claude' ? 'Anthropic' : 'Google Gemini'} API key in Settings first.`; renderMessages(); openModal(); return; }
  if (!model) { lastError = 'Enter a model name at the top.'; renderMessages(); return; }
  const history = c.messages.map(m => ({ role: m.role, content: m.content }));
  const msg = { role: 'assistant', content: '', provider: p, model };
  c.messages.push(msg);
  abort = new AbortController(); setBusy(true); renderMessages(true);
  const opts = { key, model, system: settings.system.trim(), messages: history,
    temperature: settings.temperature, maxTokens: settings.maxTokens,
    signal: abort.signal, thinking: settings.thinking,
    onStop: r => { if (!/^(STOP|end_turn|stop_sequence|FINISH_REASON_UNSPECIFIED)$/.test(String(r))) msg.cut = String(r); },
    onThought: t => { msg.thinking = (msg.thinking || '') + t; scheduleStreamRender(); },
    onChunk: t => { msg.content += t; scheduleStreamRender(); } };
  try {
    if (p === 'claude') await streamClaude(opts); else await streamGemini(opts);
  } catch (e) {
    if (e.name !== 'AbortError') lastError = e.message || String(e);
  } finally {
    if (!msg.content) c.messages.pop();
    abort = null; setBusy(false); c.updated = Date.now(); saveChats(); renderAll();
  }
}

/* ---------- provider APIs ---------- */
async function errText(res) {
  const t = await res.text();
  try { const j = JSON.parse(t); return (j.error && (j.error.message || j.error)) || t; } catch { return t || `HTTP ${res.status}`; }
}
async function readSSE(res, onData) {
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  const feed = l => { if (l.startsWith('data:')) { const d = l.slice(5).trim(); if (d && d !== '[DONE]') onData(d); } };
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    lines.forEach(feed);
  }
  buf += dec.decode();
  buf.split(/\r?\n/).forEach(feed); // don't drop a final line that had no trailing newline
}
const claudeAdaptive = m => /claude-(opus|sonnet)-(4-[6-9]|[5-9])/.test(m);
async function streamClaude({ key, model, system, messages, temperature, maxTokens, thinking, signal, onChunk, onThought, onStop }) {
  // newer models want adaptive thinking, older ones want a token budget; fall back to the other if rejected
  const modes = !thinking ? [null] : (claudeAdaptive(model) ? ['adaptive', 'enabled'] : ['enabled', 'adaptive']);
  let lastErr;
  for (const mode of modes) {
    const body = { model, max_tokens: maxTokens, stream: true, messages };
    if (system) body.system = system;
    if (mode) {
      body.max_tokens = Math.max(maxTokens, 8192);
      body.thinking = mode === 'adaptive' ? { type: 'adaptive' } : { type: 'enabled', budget_tokens: 4000 };
    } else if (temperature !== 1) body.temperature = temperature;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const msg = await errText(res);
      if (mode && mode === modes[0] && modes.length > 1 && res.status === 400 && /thinking|adaptive|budget/i.test(String(msg))) { lastErr = msg; continue; }
      throw new Error(msg);
    }
    let finished = false;
    await readSSE(res, d => {
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.type === 'content_block_delta' && j.delta) {
        if (j.delta.type === 'text_delta') onChunk(j.delta.text);
        else if (j.delta.type === 'thinking_delta') onThought(j.delta.thinking || '');
      } else if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) { finished = true; onStop(j.delta.stop_reason); }
      else if (j.type === 'error') throw new Error((j.error && j.error.message) || 'Stream error');
    });
    if (!finished) onStop('STREAM_ENDED');
    return;
  }
  throw new Error(lastErr || 'Request failed');
}
async function streamGemini({ key, model, system, messages, temperature, thinking, signal, onChunk, onThought, onStop }) {
  // try the richest request first; if the model rejects an option, step down
  const attempts = [{ thoughts: !!thinking, cap: true }];
  if (thinking) attempts.push({ thoughts: false, cap: true });
  attempts.push({ thoughts: false, cap: false });
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    const { thoughts, cap } = attempts[i];
    const generationConfig = {};
    if (temperature !== 1) generationConfig.temperature = temperature;
    if (cap) generationConfig.maxOutputTokens = 65536; // explicit high cap so replies aren't cut at a default limit
    if (thoughts) generationConfig.thinkingConfig = { includeThoughts: true };
    const body = {
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const msg = await errText(res);
      if (i < attempts.length - 1 && res.status === 400 && /thinking|thought|output.?token/i.test(String(msg))) { lastErr = msg; continue; }
      throw new Error(msg);
    }
    let finished = false;
    await readSSE(res, d => {
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.error) throw new Error(j.error.message || 'Stream error');
      if (j.promptFeedback && j.promptFeedback.blockReason) { finished = true; onStop('BLOCKED: ' + j.promptFeedback.blockReason); }
      const cand = j.candidates && j.candidates[0];
      const parts = cand && cand.content && cand.content.parts;
      if (parts) parts.forEach(p => { if (!p.text) return; if (p.thought) onThought(p.text); else onChunk(p.text); });
      if (cand && cand.finishReason) { finished = true; onStop(cand.finishReason); }
    });
    if (!finished) onStop('STREAM_ENDED');
    return;
  }
  throw new Error(lastErr || 'Request failed');
}

/* ---------- settings modal ---------- */
function openModal() {
  $('#keyClaude').value = settings.keys.claude; $('#keyGemini').value = settings.keys.gemini;
  $('#system').value = settings.system; $('#temp').value = settings.temperature; $('#tempVal').textContent = settings.temperature;
  $('#maxTokens').value = settings.maxTokens; $('#theme').value = settings.theme;
  $('#modal').classList.remove('hidden');
}
function closeModal() {
  settings.keys.claude = $('#keyClaude').value.trim(); settings.keys.gemini = $('#keyGemini').value.trim();
  settings.system = $('#system').value; settings.temperature = parseFloat($('#temp').value);
  settings.maxTokens = Math.max(256, parseInt($('#maxTokens').value) || 4096); settings.theme = $('#theme').value;
  saveSettings(); $('#modal').classList.add('hidden'); renderAll();
}

/* ---------- wiring ---------- */
function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }
$('#send').onclick = send;
$('#stop').onclick = () => abort && abort.abort();
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
$('#newChat').onclick = newChat;
$('#exportChat').onclick = exportChat;
$('#openSettings').onclick = $('#openSettings2').onclick = openModal;
$('#closeSettings').onclick = closeModal;
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
$('#temp').oninput = () => $('#tempVal').textContent = $('#temp').value;
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle(innerWidth <= 760 ? 'open' : 'collapsed');
$('#modelBtn').onclick = e => { e.stopPropagation(); const m = $('#modelMenu'); if (m.classList.contains('hidden')) { buildModelMenu(); m.classList.remove('hidden'); } else closeMenu(); };
document.addEventListener('click', e => { if (!e.target.closest('.picker')) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
$('#thinkBtn').onclick = () => { settings.thinking = !settings.thinking; saveSettings(); renderTopbar(); };
$('#wipe').onclick = () => {
  if (!confirm('Delete ALL chats and saved API keys from this browser?')) return;
  localStorage.clear(); location.reload();
};
renderAll();
