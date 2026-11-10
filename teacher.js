'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'dismissal.token';

let token = localStorage.getItem(TOKEN_KEY) || '';
let state = null;
let ws = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    Object.assign(el.style, {
      position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)',
      background: 'rgba(15,23,42,.9)', color: '#fff', padding: '10px 16px',
      borderRadius: '999px', fontSize: '13px', zIndex: 99, maxWidth: '86vw',
      textAlign: 'center', lineHeight: '1.4', transition: 'opacity .2s',
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

/* ---------- api ---------- */

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': token },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401) logout(true);
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  if (data.state) {
    state = data.state;
    renderGrades();
  }
  return data;
}

/* ---------- auth ---------- */

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
}

function logout(expired) {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  $('app').hidden = true;
  $('login').hidden = false;
  $('pass').value = '';
  $('login-err').textContent = expired ? '登录已过期，请重新输入口令' : '';
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-err');
  err.textContent = '';
  const pass = $('pass').value.trim();
  if (!pass) return;
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: pass }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '登录失败');
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    await boot();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

$('btn-logout').addEventListener('click', () => {
  if (token) fetch('/api/logout', { method: 'POST', headers: { 'x-token': token } }).catch(() => {});
  logout(false);
});

/* ---------- render ---------- */

function counts(g) {
  const total = g.classes.length;
  const done = g.classes.filter((k) => k.dismissed).length;
  return { total, done };
}

function renderGrades() {
  if (!state) return;
  let total = 0;
  let done = 0;
  for (const g of state.grades) {
    const c = counts(g);
    total += c.total;
    done += c.done;
  }
  $('sum').textContent = `已放学 ${done} / ${total}`;

  $('grades').innerHTML = state.grades.map((g) => {
    const c = counts(g);
    return `
    <section class="grade-card">
      <div class="grade-head">
        <h3>${esc(g.name)}</h3>
        <span class="pill">${c.done}/${c.total}</span>
        <div class="grade-actions">
          <button class="btn ghost sm" data-act="grade-all" data-g="${g.id}" data-on="1">全部放学</button>
          <button class="btn ghost sm" data-act="grade-all" data-g="${g.id}" data-on="0">全部未放学</button>
        </div>
      </div>
      <div class="class-grid">
        ${g.classes.map((k) => `
          <button class="class-btn${k.dismissed ? ' done' : ''}"
                  data-act="toggle" data-g="${g.id}" data-c="${k.id}">
            <span class="nm">${esc(k.name)}</span>
            <span class="st">${k.dismissed ? '已放学' : '未放学'}</span>
          </button>`).join('')}
      </div>
    </section>`;
  }).join('');
}

$('grades').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    if (act === 'toggle') {
      btn.classList.add('busy');
      await api('/api/toggle', { gradeId: btn.dataset.g, classId: btn.dataset.c });
    } else if (act === 'grade-all') {
      await api('/api/grade-all', { gradeId: btn.dataset.g, dismissed: btn.dataset.on === '1' });
    }
  } catch (ex) {
    toast(ex.message);
    btn.classList.remove('busy');
  }
});

/* ---------- websocket ---------- */

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  let retry = 0;
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        state = msg.state;
        renderGrades();
      }
    } catch { /* ignore */ }
  };
  ws.onopen = () => { retry = 0; };
  ws.onclose = () => {
    retry = Math.min(retry + 1, 6);
    setTimeout(() => { if (token) connectWS(); }, 800 * retry);
  };
}

/* ---------- sheets ---------- */

function openSheet(id) { $(id).hidden = false; }
function closeSheet(id) { $(id).hidden = true; }

document.querySelectorAll('.sheet').forEach((sheet) => {
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) sheet.hidden = true;
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; });
});

/* ---------- qr ---------- */

$('btn-qr').addEventListener('click', () => {
  const url = location.origin + '/';
  $('qr-url').textContent = url;
  $('qr-img').src = `/api/qr?u=${encodeURIComponent(url)}&_=${Date.now()}`;
  openSheet('qr-sheet');
});

$('qr-copy').addEventListener('click', async () => {
  const url = $('qr-url').textContent;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制');
  } catch {
    toast('长按上面的地址复制');
  }
});

/* ---------- settings ---------- */

function renderSettings() {
  if (!state) return;
  const body = $('settings-body');
  body.innerHTML = `
    <div class="field">
      <label>大屏标题</label>
      <input class="input plain" data-act="title" value="${esc(state.title)}" maxlength="24">
    </div>

    <div class="field">
      <label>教师口令（至少 4 位）</label>
      <div class="row">
        <input class="input plain" id="set-pass" type="password" placeholder="输入新口令" maxlength="32">
        <button class="btn primary" data-act="pass">修改</button>
      </div>
    </div>

    ${state.grades.map((g) => `
      <div class="grade-edit" data-g="${g.id}">
        <div class="ge-head">
          <input class="input plain" data-act="gname" value="${esc(g.name)}" maxlength="20">
          <div class="stepper">
            <button data-act="minus" data-g="${g.id}" aria-label="减少班级">−</button>
            <span class="num">${g.classes.length}</span>
            <button data-act="plus" data-g="${g.id}" aria-label="增加班级">＋</button>
          </div>
        </div>
        <div class="names">
          ${g.classes.map((k) => `
            <input data-act="cname" data-g="${g.id}" data-c="${k.id}" value="${esc(k.name)}" maxlength="12">
          `).join('')}
        </div>
      </div>`).join('')}

    <button class="btn danger" data-act="reset">全部恢复为「未放学」</button>
    <p class="note">修改即时保存，大屏会同步更新。每个年级最多 ${12} 个班，最少 1 个。</p>
  `;
}

$('btn-settings').addEventListener('click', () => {
  renderSettings();
  openSheet('settings-sheet');
});

$('settings-body').addEventListener('change', async (e) => {
  const el = e.target;
  const act = el.dataset.act;
  if (!act) return;
  try {
    if (act === 'title') {
      await api('/api/settings', { title: el.value });
      toast('标题已更新');
    } else if (act === 'gname') {
      await api('/api/grade', { gradeId: el.dataset.g, name: el.value });
    } else if (act === 'cname') {
      await api('/api/class-name', { gradeId: el.dataset.g, classId: el.dataset.c, name: el.value });
    }
  } catch (ex) {
    toast(ex.message);
    renderSettings();
  }
});

$('settings-body').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    if (act === 'plus' || act === 'minus') {
      const g = state.grades.find((x) => x.id === btn.dataset.g);
      if (!g) return;
      const next = g.classes.length + (act === 'plus' ? 1 : -1);
      if (next < 1 || next > 12) return;
      await api('/api/grade', { gradeId: g.id, count: next });
      renderSettings();
    } else if (act === 'pass') {
      const v = $('set-pass').value.trim();
      if (v.length < 4) return toast('口令至少 4 位');
      await api('/api/settings', { passcode: v });
      $('set-pass').value = '';
      toast('口令已修改');
    } else if (act === 'reset') {
      if (!confirm('把全部班级恢复为「未放学」？')) return;
      await api('/api/reset');
      closeSheet('settings-sheet');
      toast('已全部恢复');
    }
  } catch (ex) {
    toast(ex.message);
  }
});

/* ---------- boot ---------- */

async function boot() {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error('读取状态失败');
  state = await res.json();
  showApp();
  renderGrades();
  if (ws) ws.close();
  connectWS();
}

if (token) {
  boot().catch(() => logout(false));
} else {
  $('login').hidden = false;
}
