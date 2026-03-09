/* NanoClaw Web Chat - Frontend Logic */

// ===== State =====
let token = localStorage.getItem('token') || '';
let username = localStorage.getItem('username') || '';
let userRole = localStorage.getItem('userRole') || '';
let ws = null;
let currentConvId = null;
let isAuthMode = 'login'; // 'login' | 'register'
let wsReconnectTimer = null;
let adminActive = false;
let activeAdminTab = 'usage';

// ===== DOM refs =====
const loginPage     = document.getElementById('login-page');
const app           = document.getElementById('app');
const authTitle     = document.getElementById('auth-title');
const authUsername  = document.getElementById('auth-username');
const authPassword  = document.getElementById('auth-password');
const authError     = document.getElementById('auth-error');
const authSubmit    = document.getElementById('auth-submit');
const toggleAuth    = document.getElementById('toggle-auth');
const convList      = document.getElementById('conv-list');
const messages      = document.getElementById('messages');
const emptyState    = document.getElementById('empty-state');
const typingIndicator = document.getElementById('typing-indicator');
const inputArea     = document.getElementById('input-area');
const msgInput      = document.getElementById('msg-input');
const sendBtn       = document.getElementById('send-btn');
const sidebarUsername = document.getElementById('sidebar-username');
const newChatBtn    = document.getElementById('new-chat-btn');
const logoutBtn     = document.getElementById('logout-btn');
const adminBtn      = document.getElementById('admin-btn');
const adminPanel    = document.getElementById('admin-panel');
const adminContent  = document.getElementById('admin-content');

// ===== Auth =====

toggleAuth.addEventListener('click', (e) => {
  e.preventDefault();
  isAuthMode = isAuthMode === 'login' ? 'register' : 'login';
  authTitle.textContent = isAuthMode === 'login' ? '登录' : '注册';
  authSubmit.textContent = isAuthMode === 'login' ? '登录' : '注册';
  toggleAuth.textContent = isAuthMode === 'login' ? '注册' : '登录';
  toggleAuth.previousSibling.textContent = isAuthMode === 'login' ? '没有账号？' : '已有账号？';
  authError.textContent = '';
});

authSubmit.addEventListener('click', () => doAuth());
authPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });

async function doAuth() {
  const uname = authUsername.value.trim();
  const pwd   = authPassword.value;
  authError.textContent = '';

  if (!uname || !pwd) {
    authError.textContent = '请填写用户名和密码';
    return;
  }

  const endpoint = isAuthMode === 'login' ? '/api/auth/login' : '/api/auth/register';
  const status   = isAuthMode === 'login' ? 200 : 201;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: pwd }),
    });
    const data = await res.json();
    if (res.status !== status) {
      authError.textContent = data.error || '操作失败';
      return;
    }
    token    = data.token;
    username = data.username;
    userRole = data.role || 'member';
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
    localStorage.setItem('userRole', userRole);
    enterApp();
  } catch (err) {
    authError.textContent = '网络错误，请重试';
  }
}

// ===== App Entry =====

function enterApp() {
  loginPage.classList.add('hidden');
  app.classList.remove('hidden');
  sidebarUsername.textContent = username;

  // Show admin button for owners
  if (userRole === 'owner') {
    adminBtn.classList.remove('hidden');
  } else {
    adminBtn.classList.add('hidden');
  }

  loadConversations();
  connectWs();
}

function logout() {
  token = '';
  username = '';
  userRole = '';
  currentConvId = null;
  adminActive = false;
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  localStorage.removeItem('userRole');
  if (ws) { ws.close(); ws = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  app.classList.add('hidden');
  loginPage.classList.remove('hidden');
  authUsername.value = '';
  authPassword.value = '';
}

logoutBtn.addEventListener('click', logout);

// ===== WebSocket =====

function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  });

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    handleWsMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (token) {
      wsReconnectTimer = setTimeout(() => connectWs(), 3000);
    }
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      // Update role from server (handles old tokens)
      if (msg.role) {
        userRole = msg.role;
        localStorage.setItem('userRole', userRole);
        if (userRole === 'owner') adminBtn.classList.remove('hidden');
        else adminBtn.classList.add('hidden');
      }
      break;
    case 'subscribed':
      // ready
      break;
    case 'message':
      if (msg.convId === currentConvId || !msg.convId) {
        appendMessage(msg.role, msg.content, msg.timestamp, msg.id);
      }
      break;
    case 'typing':
      if (currentConvId) {
        typingIndicator.classList.toggle('hidden', !msg.isTyping);
      }
      break;
    case 'error':
      console.warn('WS error:', msg.message);
      break;
  }
}

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ===== Conversations =====

async function loadConversations() {
  try {
    const res = await authFetch('/api/conversations');
    if (!res.ok) return;
    const convs = await res.json();
    renderConvList(convs);
  } catch {}
}

function renderConvList(convs) {
  convList.innerHTML = '';
  for (const c of convs) {
    const el = document.createElement('div');
    el.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
    el.textContent = c.title;
    el.dataset.id = c.id;
    el.addEventListener('click', () => openConversation(c.id, c.title));
    convList.appendChild(el);
  }
}

newChatBtn.addEventListener('click', async () => {
  const title = '新对话 ' + new Date().toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  try {
    const res = await authFetch('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return;
    const conv = await res.json();
    await loadConversations();
    openConversation(conv.id, conv.title);
  } catch {}
});

async function openConversation(convId, title) {
  currentConvId = convId;
  adminActive = false;

  // Hide admin panel, show chat
  adminPanel.classList.add('hidden');

  // Update active state in sidebar
  for (const el of convList.querySelectorAll('.conv-item')) {
    el.classList.toggle('active', el.dataset.id === convId);
  }

  // Show chat area
  emptyState.classList.add('hidden');
  messages.classList.remove('hidden');
  inputArea.classList.remove('hidden');
  typingIndicator.classList.add('hidden');

  // Load history
  messages.innerHTML = '';
  try {
    const res = await authFetch(`/api/conversations/${convId}/messages`);
    if (res.ok) {
      const msgs = await res.json();
      for (const m of msgs) appendMessage(m.role, m.content, m.timestamp, m.id, false);
    }
  } catch {}

  // Subscribe via WS
  wsSend({ type: 'subscribe', convId });

  // Scroll to bottom
  scrollBottom();
  msgInput.focus();
}

// ===== Messages =====

function appendMessage(role, content, timestamp, id, scroll = true) {
  // Deduplicate
  if (id && document.getElementById('msg-' + id)) return;

  const row = document.createElement('div');
  row.className = `msg-row ${role}`;
  if (id) row.id = 'msg-' + id;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (role === 'assistant') {
    bubble.innerHTML = marked.parse(content || '');
  } else {
    bubble.textContent = content;
  }

  row.appendChild(bubble);
  messages.appendChild(row);
  if (scroll) scrollBottom();
}

function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
}

// ===== Send =====

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
});

function sendMessage() {
  const content = msgInput.value.trim();
  if (!content || !currentConvId) return;

  wsSend({ type: 'message', convId: currentConvId, content });
  msgInput.value = '';
  msgInput.style.height = 'auto';
}

// ===== Admin =====

adminBtn.addEventListener('click', () => {
  adminActive = true;
  currentConvId = null;

  // Hide chat, show admin
  emptyState.classList.add('hidden');
  messages.classList.add('hidden');
  inputArea.classList.add('hidden');
  typingIndicator.classList.add('hidden');
  adminPanel.classList.remove('hidden');

  // Deselect conversations
  for (const el of convList.querySelectorAll('.conv-item')) {
    el.classList.remove('active');
  }

  loadAdminTab(activeAdminTab);
});

// Tab switching
adminPanel.addEventListener('click', (e) => {
  const tab = e.target.closest('.admin-tab');
  if (!tab) return;
  activeAdminTab = tab.dataset.tab;
  for (const t of adminPanel.querySelectorAll('.admin-tab')) {
    t.classList.toggle('active', t.dataset.tab === activeAdminTab);
  }
  loadAdminTab(activeAdminTab);
});

async function loadAdminTab(tab) {
  adminContent.innerHTML = '<div class="admin-loading">Loading...</div>';
  switch (tab) {
    case 'usage': return loadUsageTab();
    case 'users': return loadUsersTab();
    case 'audit': return loadAuditTab();
    case 'skills': return loadSkillsTab();
  }
}

// --- Usage Tab ---
async function loadUsageTab() {
  try {
    const res = await authFetch('/api/admin/usage');
    if (!res.ok) { adminContent.innerHTML = '<p>Failed to load</p>'; return; }
    const data = await res.json();

    let html = `<table class="admin-table">
      <thead><tr>
        <th>User</th><th>Role</th><th>Input</th><th>Output</th><th>Total</th><th>Quota</th><th>Usage</th>
      </tr></thead><tbody>`;

    for (const u of data) {
      const pct = u.quota > 0 ? Math.min(100, Math.round((u.total / u.quota) * 100)) : 0;
      const barClass = pct >= 90 ? 'bar-danger' : pct >= 70 ? 'bar-warn' : '';
      html += `<tr>
        <td>${esc(u.username)}</td>
        <td><span class="role-badge role-${u.role}">${u.role}</span></td>
        <td>${fmtTokens(u.token_input)}</td>
        <td>${fmtTokens(u.token_output)}</td>
        <td>${fmtTokens(u.total)}</td>
        <td>${u.role === 'owner' ? '∞' : fmtTokens(u.quota)}</td>
        <td class="usage-cell">
          <div class="usage-bar"><div class="usage-fill ${barClass}" style="width:${pct}%"></div></div>
          <span class="usage-pct">${u.role === 'owner' ? '-' : pct + '%'}</span>
        </td>
      </tr>`;
    }

    html += '</tbody></table>';
    adminContent.innerHTML = html;
  } catch {
    adminContent.innerHTML = '<p>Error loading usage data</p>';
  }
}

// --- Users Tab ---
async function loadUsersTab() {
  try {
    const res = await authFetch('/api/admin/users');
    if (!res.ok) { adminContent.innerHTML = '<p>Failed to load</p>'; return; }
    const users = await res.json();

    let html = `<table class="admin-table">
      <thead><tr>
        <th>User</th><th>Role</th><th>Quota</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody>`;

    for (const u of users) {
      html += `<tr data-uid="${u.id}">
        <td>${esc(u.username)}</td>
        <td>
          <select class="admin-select role-select" data-uid="${u.id}" ${u.role === 'owner' ? '' : ''}>
            <option value="owner" ${u.role === 'owner' ? 'selected' : ''}>owner</option>
            <option value="member" ${u.role === 'member' ? 'selected' : ''}>member</option>
          </select>
        </td>
        <td>
          <input type="number" class="admin-input quota-input" data-uid="${u.id}"
            value="${u.monthly_quota}" min="0" step="10000" />
        </td>
        <td>
          <label class="switch">
            <input type="checkbox" class="enabled-toggle" data-uid="${u.id}" ${u.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </td>
        <td>
          <button class="btn-sm save-user-btn" data-uid="${u.id}">Save</button>
        </td>
      </tr>`;
    }

    html += '</tbody></table>';
    adminContent.innerHTML = html;

    // Save handlers
    adminContent.querySelectorAll('.save-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.uid;
        const row = btn.closest('tr');
        const role = row.querySelector('.role-select').value;
        const quota = parseInt(row.querySelector('.quota-input').value, 10) || 0;
        const enabled = row.querySelector('.enabled-toggle').checked ? 1 : 0;

        btn.textContent = '...';
        try {
          const res = await authFetch(`/api/admin/users/${uid}`, {
            method: 'PUT',
            body: JSON.stringify({ role, enabled, monthly_quota: quota }),
          });
          const data = await res.json();
          if (!res.ok) {
            btn.textContent = data.error || 'Error';
            setTimeout(() => btn.textContent = 'Save', 2000);
          } else {
            btn.textContent = 'Saved';
            setTimeout(() => btn.textContent = 'Save', 1500);
          }
        } catch {
          btn.textContent = 'Error';
          setTimeout(() => btn.textContent = 'Save', 2000);
        }
      });
    });
  } catch {
    adminContent.innerHTML = '<p>Error loading users</p>';
  }
}

// --- Audit Tab ---
async function loadAuditTab() {
  const html = `<div class="audit-filters">
    <select id="audit-action" class="admin-select">
      <option value="">All Actions</option>
      <option value="agent_invoked">agent_invoked</option>
      <option value="agent_completed">agent_completed</option>
      <option value="session_rotated">session_rotated</option>
    </select>
    <input id="audit-limit" type="number" class="admin-input" value="50" min="1" max="500" placeholder="Limit" />
    <button id="audit-fetch" class="btn-sm">Fetch</button>
  </div>
  <div id="audit-table-wrap"></div>`;
  adminContent.innerHTML = html;

  document.getElementById('audit-fetch').addEventListener('click', fetchAuditLogs);
  fetchAuditLogs();
}

async function fetchAuditLogs() {
  const action = document.getElementById('audit-action').value;
  const limit = document.getElementById('audit-limit').value || '50';
  const wrap = document.getElementById('audit-table-wrap');

  let url = `/api/admin/audit-logs?limit=${limit}`;
  if (action) url += `&action=${action}`;

  try {
    const res = await authFetch(url);
    if (!res.ok) { wrap.innerHTML = '<p>Failed</p>'; return; }
    const logs = await res.json();

    let tbl = `<table class="admin-table audit-table">
      <thead><tr>
        <th>Time</th><th>Action</th><th>User</th><th>Channel</th><th>Tokens</th><th>Duration</th>
      </tr></thead><tbody>`;

    for (const l of logs) {
      const tokens = (l.token_input || l.token_output)
        ? `${fmtTokens(l.token_input || 0)} / ${fmtTokens(l.token_output || 0)}`
        : '-';
      const dur = l.duration_ms ? (l.duration_ms / 1000).toFixed(1) + 's' : '-';
      tbl += `<tr>
        <td class="mono">${fmtTime(l.timestamp)}</td>
        <td><span class="action-badge">${l.action}</span></td>
        <td>${l.user_id ? l.user_id.slice(0, 8) : '-'}</td>
        <td>${l.channel || '-'}</td>
        <td>${tokens}</td>
        <td>${dur}</td>
      </tr>`;
    }

    tbl += '</tbody></table>';
    wrap.innerHTML = logs.length === 0 ? '<p class="admin-empty">No logs found</p>' : tbl;
  } catch {
    wrap.innerHTML = '<p>Error loading audit logs</p>';
  }
}

// --- Skills Tab ---
async function loadSkillsTab() {
  try {
    const res = await authFetch('/api/admin/skills');
    if (!res.ok) { adminContent.innerHTML = '<p>Failed to load</p>'; return; }
    const skills = await res.json();

    if (skills.length === 0) {
      adminContent.innerHTML = '<p class="admin-empty">No skills found</p>';
      return;
    }

    let html = `<table class="admin-table">
      <thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>`;
    for (const s of skills) {
      html += `<tr>
        <td><strong>${esc(s.name)}</strong></td>
        <td><span class="type-badge">${esc(s.type)}</span></td>
        <td>${esc(s.description) || '<span class="text-muted">-</span>'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    adminContent.innerHTML = html;
  } catch {
    adminContent.innerHTML = '<p>Error loading skills</p>';
  }
}

// ===== Utils =====

function authFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function fmtTokens(n) {
  if (n == null) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ===== Boot =====

if (token) {
  enterApp();
} else {
  loginPage.classList.remove('hidden');
}
