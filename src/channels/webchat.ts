import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';

import {
  WEB_PORT,
  WEB_JWT_SECRET,
  GROUPS_DIR,
  PROJECT_ROOT,
  DEFAULT_MONTHLY_QUOTA,
} from '../config.js';
import {
  createWebUser,
  createWebConversation,
  getWebConversationsByUser,
  getWebConversation,
  getWebConversationMessages,
  getWebUserByUsername,
  getWebUserById,
  getAllWebUsers,
  updateWebUser,
  countWebUsers,
  getUserMonthlyTokenUsage,
  getAuditLogs,
  getTokenUsageSummary,
  touchWebConversation,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';

const WEB_DIR = path.resolve(PROJECT_ROOT, 'web');

// MIME types for static files
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

interface AuthenticatedClient {
  ws: WebSocket;
  userId: string;
  username: string;
  convId: string | null;
}

interface JwtPayload {
  sub: string; // userId
  username: string;
  role?: 'owner' | 'member';
}

export interface WebChatChannelOpts {
  registerGroup(jid: string, group: RegisteredGroup): void;
}

export class WebChatChannel implements Channel {
  name = 'webchat';

  private clients = new Map<string, AuthenticatedClient>(); // sessionId → client
  private jidSubs = new Map<string, Set<string>>(); // jid → Set<sessionId>
  private server!: http.Server;
  private wss!: WebSocketServer;
  private opts: WebChatChannelOpts;

  constructor(opts: WebChatChannelOpts) {
    this.opts = opts;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@webchat');
  }

  isConnected(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        logger.error({ err }, 'WebChat HTTP error');
        res.writeHead(500).end('Internal Server Error');
      });
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.handleWsConnection(ws));

    await new Promise<void>((resolve) => {
      this.server.listen(WEB_PORT, () => {
        logger.info({ port: WEB_PORT }, 'WebChat HTTP server started');
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const subs = this.jidSubs.get(jid);
    if (!subs) return;
    const payload = JSON.stringify({ type: 'typing', isTyping });
    for (const sid of subs) {
      const c = this.clients.get(sid);
      if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Store bot message
    storeMessageDirect({
      id: randomUUID(),
      chat_jid: jid,
      sender: 'assistant',
      sender_name: 'assistant',
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });

    // Extract convId from jid: webchat-{convId}@webchat
    const convId = jid.replace(/^webchat-/, '').replace(/@webchat$/, '');
    touchWebConversation(convId);

    const subs = this.jidSubs.get(jid);
    if (!subs) return;
    const payload = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: text,
      timestamp: new Date().toISOString(),
      id: randomUUID(),
    });
    for (const sid of subs) {
      const c = this.clients.get(sid);
      if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  }

  // --- HTTP handler ---

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // REST API routes
    if (pathname === '/api/auth/register' && method === 'POST') {
      return this.handleRegister(req, res);
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      return this.handleLogin(req, res);
    }
    if (pathname === '/api/conversations' && method === 'GET') {
      return this.handleGetConversations(req, res);
    }
    if (pathname === '/api/conversations' && method === 'POST') {
      return this.handleCreateConversation(req, res);
    }
    const msgMatch = pathname.match(
      /^\/api\/conversations\/([^/]+)\/messages$/,
    );
    if (msgMatch && method === 'GET') {
      return this.handleGetMessages(req, res, msgMatch[1]);
    }

    // User self-service
    if (pathname === '/api/me/usage' && method === 'GET') {
      return this.handleMyUsage(req, res);
    }

    // Admin API
    if (pathname === '/api/admin/users' && method === 'GET') {
      return this.handleAdminGetUsers(req, res);
    }
    const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch && method === 'PUT') {
      return this.handleAdminUpdateUser(req, res, userMatch[1]);
    }
    if (pathname === '/api/admin/usage' && method === 'GET') {
      return this.handleAdminUsage(req, res);
    }
    if (pathname === '/api/admin/audit-logs' && method === 'GET') {
      return this.handleAdminAuditLogs(req, res);
    }
    if (pathname === '/api/admin/skills' && method === 'GET') {
      return this.handleAdminSkills(req, res);
    }

    // Static files
    return this.serveStatic(pathname, res);
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private verifyJwt(req: http.IncomingMessage): JwtPayload | null {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return null;
    try {
      const payload = jwt.verify(auth.slice(7), WEB_JWT_SECRET) as JwtPayload;
      // Check user is still enabled and fill role from DB (handles old JWTs without role)
      const user = getWebUserById(payload.sub);
      if (!user || !user.enabled) return null;
      payload.role = user.role;
      return payload;
    } catch {
      return null;
    }
  }

  private verifyOwner(req: http.IncomingMessage): JwtPayload | null {
    const payload = this.verifyJwt(req);
    if (!payload || payload.role !== 'owner') return null;
    return payload;
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }

  private async handleRegister(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: { username?: string; password?: string };
    try {
      body = (await this.readBody(req)) as typeof body;
    } catch {
      return this.json(res, 400, { error: 'Invalid JSON' });
    }

    const { username, password } = body;
    if (!username || !password || username.length < 2 || password.length < 6) {
      return this.json(res, 400, {
        error: 'Username ≥ 2 chars, password ≥ 6 chars',
      });
    }
    if (getWebUserByUsername(username)) {
      return this.json(res, 409, { error: 'Username already taken' });
    }

    const id = randomUUID();
    const password_hash = await bcrypt.hash(password, 10);
    const role = countWebUsers() === 0 ? 'owner' : 'member';
    createWebUser({
      id,
      username,
      password_hash,
      created_at: new Date().toISOString(),
      role,
      enabled: 1,
      monthly_quota: DEFAULT_MONTHLY_QUOTA,
    });

    const token = jwt.sign({ sub: id, username, role }, WEB_JWT_SECRET, {
      expiresIn: '30d',
    });
    return this.json(res, 201, { token, username, role });
  }

  private async handleLogin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: { username?: string; password?: string };
    try {
      body = (await this.readBody(req)) as typeof body;
    } catch {
      return this.json(res, 400, { error: 'Invalid JSON' });
    }

    const { username, password } = body;
    if (!username || !password) {
      return this.json(res, 400, { error: 'Missing credentials' });
    }

    const user = getWebUserByUsername(username);
    if (!user) return this.json(res, 401, { error: 'Invalid credentials' });
    if (!user.enabled)
      return this.json(res, 403, { error: 'Account disabled' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return this.json(res, 401, { error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: user.id, username, role: user.role },
      WEB_JWT_SECRET,
      { expiresIn: '30d' },
    );
    return this.json(res, 200, { token, username, role: user.role });
  }

  private handleGetConversations(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const payload = this.verifyJwt(req);
    if (!payload) return this.json(res, 401, { error: 'Unauthorized' });

    const convs = getWebConversationsByUser(payload.sub);
    return this.json(res, 200, convs);
  }

  private async handleCreateConversation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const payload = this.verifyJwt(req);
    if (!payload) return this.json(res, 401, { error: 'Unauthorized' });

    let body: { title?: string };
    try {
      body = (await this.readBody(req)) as typeof body;
    } catch {
      return this.json(res, 400, { error: 'Invalid JSON' });
    }

    const convId = randomUUID().replace(/-/g, '').slice(0, 16);
    const folder = `webchat-${convId}`;
    const jid = `${folder}@webchat`;
    const now = new Date().toISOString();
    const title = body.title || `Chat ${new Date().toLocaleDateString()}`;

    createWebConversation({
      id: convId,
      user_id: payload.sub,
      title,
      created_at: now,
      last_message_at: now,
    });

    this.opts.registerGroup(jid, {
      name: title,
      folder,
      trigger: '',
      added_at: now,
      requiresTrigger: false,
      userId: payload.sub,
    });

    storeChatMetadata(jid, now, title, 'webchat', true);

    return this.json(res, 201, {
      id: convId,
      title,
      created_at: now,
      last_message_at: now,
    });
  }

  private handleGetMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    convId: string,
  ): void {
    const payload = this.verifyJwt(req);
    if (!payload) return this.json(res, 401, { error: 'Unauthorized' });

    const conv = getWebConversation(convId, payload.sub);
    if (!conv) return this.json(res, 404, { error: 'Not found' });

    const msgs = getWebConversationMessages(convId).reverse();
    return this.json(
      res,
      200,
      msgs.map((m) => ({
        id: m.id,
        role: m.is_bot_message ? 'assistant' : 'user',
        content: m.content,
        timestamp: m.timestamp,
      })),
    );
  }

  // --- User self-service ---

  private handleMyUsage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const payload = this.verifyJwt(req);
    if (!payload) return this.json(res, 401, { error: 'Unauthorized' });

    const usage = getUserMonthlyTokenUsage(payload.sub);
    const user = getWebUserById(payload.sub);
    return this.json(res, 200, {
      usage,
      quota: user?.monthly_quota ?? DEFAULT_MONTHLY_QUOTA,
      role: user?.role ?? 'member',
    });
  }

  // --- Admin API ---

  private handleAdminGetUsers(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (!this.verifyOwner(req))
      return this.json(res, 403, { error: 'Forbidden' });

    const users = getAllWebUsers().map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      enabled: u.enabled,
      monthly_quota: u.monthly_quota,
      created_at: u.created_at,
    }));
    return this.json(res, 200, users);
  }

  private async handleAdminUpdateUser(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    userId: string,
  ): Promise<void> {
    const owner = this.verifyOwner(req);
    if (!owner) return this.json(res, 403, { error: 'Forbidden' });

    let body: { role?: string; enabled?: number; monthly_quota?: number };
    try {
      body = (await this.readBody(req)) as typeof body;
    } catch {
      return this.json(res, 400, { error: 'Invalid JSON' });
    }

    const target = getWebUserById(userId);
    if (!target) return this.json(res, 404, { error: 'User not found' });

    // Prevent owner from demoting themselves
    if (userId === owner.sub && body.role && body.role !== 'owner') {
      return this.json(res, 400, { error: 'Cannot demote yourself' });
    }

    const updates: { role?: 'owner' | 'member'; enabled?: number; monthly_quota?: number } = {};
    if (body.role === 'owner' || body.role === 'member') updates.role = body.role;
    if (body.enabled === 0 || body.enabled === 1) updates.enabled = body.enabled;
    if (typeof body.monthly_quota === 'number' && body.monthly_quota >= 0)
      updates.monthly_quota = body.monthly_quota;

    updateWebUser(userId, updates);
    return this.json(res, 200, { ok: true });
  }

  private handleAdminUsage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (!this.verifyOwner(req))
      return this.json(res, 403, { error: 'Forbidden' });

    const users = getAllWebUsers();
    const now = new Date();
    const monthStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      1,
    ).toISOString();

    const result = users.map((u) => {
      const summary = getTokenUsageSummary({ userId: u.id, since: monthStart });
      return {
        id: u.id,
        username: u.username,
        role: u.role,
        token_input: summary.total_input,
        token_output: summary.total_output,
        total: summary.total_input + summary.total_output,
        quota: u.monthly_quota,
        invocations: summary.invocation_count,
      };
    });
    return this.json(res, 200, result);
  }

  private handleAdminAuditLogs(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (!this.verifyOwner(req))
      return this.json(res, 403, { error: 'Forbidden' });

    const url = new URL(req.url || '/', 'http://localhost');
    const userId = url.searchParams.get('user') ?? undefined;
    const action = url.searchParams.get('action') as import('../types.js').AuditAction | undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') || '100', 10) || 100;

    const logs = getAuditLogs({ userId, action: action || undefined, since, limit });
    return this.json(res, 200, logs);
  }

  private handleAdminSkills(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (!this.verifyOwner(req))
      return this.json(res, 403, { error: 'Forbidden' });

    const skills: Array<{ name: string; type: string; description: string }> = [];

    // Scan container/skills/
    const containerSkillsDir = path.resolve(PROJECT_ROOT, 'container', 'skills');
    if (fs.existsSync(containerSkillsDir)) {
      try {
        for (const entry of fs.readdirSync(containerSkillsDir, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory()) continue;
          const metaPath = path.join(containerSkillsDir, entry.name, '_meta.json');
          let desc = '';
          if (fs.existsSync(metaPath)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
              desc = meta.description || '';
            } catch { /* ignore */ }
          }
          skills.push({ name: entry.name, type: 'container', description: desc });
        }
      } catch { /* ignore */ }
    }

    // Scan groups/*/. claude/skills/
    if (fs.existsSync(GROUPS_DIR)) {
      try {
        for (const groupEntry of fs.readdirSync(GROUPS_DIR, {
          withFileTypes: true,
        })) {
          if (!groupEntry.isDirectory()) continue;
          const groupSkillsDir = path.join(
            GROUPS_DIR,
            groupEntry.name,
            '.claude',
            'skills',
          );
          if (!fs.existsSync(groupSkillsDir)) continue;
          for (const entry of fs.readdirSync(groupSkillsDir, {
            withFileTypes: true,
          })) {
            if (!entry.isDirectory()) continue;
            const metaPath = path.join(groupSkillsDir, entry.name, '_meta.json');
            let desc = '';
            if (fs.existsSync(metaPath)) {
              try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                desc = meta.description || '';
              } catch { /* ignore */ }
            }
            skills.push({
              name: entry.name,
              type: `group:${groupEntry.name}`,
              description: desc,
            });
          }
        }
      } catch { /* ignore */ }
    }

    return this.json(res, 200, skills);
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    // Prevent path traversal
    const safePath = path.resolve(WEB_DIR, '.' + pathname);
    if (!safePath.startsWith(WEB_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    // Default to index.html
    let filePath = safePath;
    if (pathname === '/' || !path.extname(pathname)) {
      filePath = path.join(WEB_DIR, 'index.html');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not Found');
        return;
      }
      const ext = path.extname(filePath);
      const ct = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    });
  }

  // --- WebSocket handler ---

  private handleWsConnection(ws: WebSocket): void {
    const sessionId = randomUUID();

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleWsMessage(sessionId, ws, msg).catch((err) =>
          logger.error({ err }, 'WS message error'),
        );
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      const client = this.clients.get(sessionId);
      if (client?.convId) {
        const jid = `webchat-${client.convId}@webchat`;
        const subs = this.jidSubs.get(jid);
        subs?.delete(sessionId);
      }
      this.clients.delete(sessionId);
    });
  }

  private async handleWsMessage(
    sessionId: string,
    ws: WebSocket,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    if (msg.type === 'auth') {
      const token = msg.token as string;
      let payload: JwtPayload;
      try {
        payload = jwt.verify(token, WEB_JWT_SECRET) as JwtPayload;
      } catch {
        send({ type: 'error', message: 'Invalid token' });
        return;
      }
      // Check user is still enabled
      const user = getWebUserById(payload.sub);
      if (!user || !user.enabled) {
        send({ type: 'error', message: 'Account disabled' });
        return;
      }
      this.clients.set(sessionId, {
        ws,
        userId: payload.sub,
        username: payload.username,
        convId: null,
      });
      send({ type: 'auth_ok', username: payload.username, role: user.role });
      return;
    }

    const client = this.clients.get(sessionId);
    if (!client) {
      send({ type: 'error', message: 'Not authenticated' });
      return;
    }

    if (msg.type === 'subscribe') {
      const convId = msg.convId as string;
      const conv = getWebConversation(convId, client.userId);
      if (!conv) {
        send({ type: 'error', message: 'Conversation not found' });
        return;
      }
      // Unsubscribe from previous
      if (client.convId) {
        const oldJid = `webchat-${client.convId}@webchat`;
        this.jidSubs.get(oldJid)?.delete(sessionId);
      }
      client.convId = convId;
      const jid = `webchat-${convId}@webchat`;
      if (!this.jidSubs.has(jid)) this.jidSubs.set(jid, new Set());
      this.jidSubs.get(jid)!.add(sessionId);
      send({ type: 'subscribed', convId });
      return;
    }

    if (msg.type === 'message') {
      const convId = msg.convId as string;
      const content = msg.content as string;
      if (!content?.trim()) return;

      const conv = getWebConversation(convId, client.userId);
      if (!conv) {
        send({ type: 'error', message: 'Conversation not found' });
        return;
      }

      // Quota check for non-owner users
      const msgUser = getWebUserById(client.userId);
      if (msgUser && msgUser.role !== 'owner') {
        const usage = getUserMonthlyTokenUsage(client.userId);
        if (usage >= msgUser.monthly_quota) {
          send({
            type: 'error',
            message: '本月额度已用完，请联系管理员。',
          });
          return;
        }
      }

      const jid = `webchat-${convId}@webchat`;
      const msgId = randomUUID();
      const timestamp = new Date().toISOString();

      storeMessageDirect({
        id: msgId,
        chat_jid: jid,
        sender: client.userId,
        sender_name: client.username,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
      storeChatMetadata(jid, timestamp, conv.title, 'webchat', true);
      touchWebConversation(convId);

      // Echo to all subscribers
      const subs = this.jidSubs.get(jid);
      if (subs) {
        const echo = JSON.stringify({
          type: 'message',
          role: 'user',
          content,
          timestamp,
          id: msgId,
        });
        for (const sid of subs) {
          const c = this.clients.get(sid);
          if (c?.ws.readyState === WebSocket.OPEN) c.ws.send(echo);
        }
      }
      return;
    }

    send({ type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}
