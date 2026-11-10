'use strict';

const $ = (id) => document.getElementById(id);
const board = $('board');
const titleEl = $('title');
const summaryEl = $('summary');
const clockEl = $('clock');
const dateEl = $('date');
const liveEl = $('live');

let state = null;
let prev = new Map();
let ws = null;
let retry = 0;
let pollTimer = null;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function tick() {
  const now = new Date();
  clockEl.textContent = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  dateEl.textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${weeks[now.getDay()]}`;
}

function render(next) {
  state = next;
  titleEl.textContent = state.title || '放学状态';

  let total = 0;
  let done = 0;
  for (const g of state.grades) {
    for (const k of g.classes) {
      total++;
      if (k.dismissed) done++;
    }
  }
  summaryEl.innerHTML = `已放学 <b>${done}</b> / ${total}`;

  const changed = new Set();
  for (const g of state.grades) {
    for (const k of g.classes) {
      const was = prev.get(k.id);
      if (was !== undefined && was !== k.dismissed) changed.add(k.id);
      prev.set(k.id, k.dismissed);
    }
  }

  board.innerHTML = state.grades.map((g) => `
    <div class="grade-row">
      <div class="grade-name">
        <span class="gname">${esc(g.name)}</span>
        <span class="gcount">${g.classes.filter((k) => k.dismissed).length}/${g.classes.length} 已放学</span>
      </div>
      <div class="cells" style="--n:${g.classes.length}">
        ${g.classes.map((k) => `
          <div class="cell${k.dismissed ? ' done' : ''}${changed.has(k.id) ? ' changed' : ''}" data-id="${k.id}">
            <div class="cname">${esc(k.name)}</div>
            <div class="cstate">${k.dismissed ? '已放学' : '未放学'}</div>
            ${k.dismissed && k.dismissedAt ? `<div class="ctime">${hhmm(k.dismissedAt)} 放学</div>` : ''}
          </div>`).join('')}
      </div>
    </div>`).join('');

  setTimeout(() => {
    for (const el of board.querySelectorAll('.cell.changed')) el.classList.remove('changed');
  }, 1600);
}

async function load() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    render(await r.json());
    liveEl.classList.remove('off');
  } catch {
    liveEl.classList.add('off');
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    retry = 0;
    liveEl.classList.remove('off');
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') render(msg.state);
    } catch { /* ignore */ }
  };

  ws.onclose = () => {
    liveEl.classList.add('off');
    if (!pollTimer) pollTimer = setInterval(load, 5000);
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 800 * retry);
  };

  ws.onerror = () => ws.close();
}

tick();
setInterval(tick, 1000);
load();
connect();

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
