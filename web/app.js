/* NanoClaw Web Chat - Frontend Logic */

// ===== State =====
let token = localStorage.getItem('token') || '';
let username = localStorage.getItem('username') || '';
let ws = null;
let currentConvId = null;
let isAuthMode = 'login'; // 'login' | 'register'
let wsReconnectTimer = null;

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
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
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
  loadConversations();
  connectWs();
}

function logout() {
  token = '';
  username = '';
  currentConvId = null;
  localStorage.removeItem('token');
  localStorage.removeItem('username');
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
      // Load conversations already done in enterApp, nothing extra needed
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

// ===== Boot =====

if (token) {
  enterApp();
} else {
  loginPage.classList.remove('hidden');
}
