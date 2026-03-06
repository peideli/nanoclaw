import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';

import { WEB_PORT, WEB_JWT_SECRET, GROUPS_DIR } from '../config.js';
import {
  createWebUser,
  createWebConversation,
  getWebConversationsByUser,
  getWebConversation,
  getWebConversationMessages,
  getWebUserByUsername,
  touchWebConversation,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, RegisteredGroup } from '../types.js';

const WEB_DIR = path.resolve(process.cwd(), 'web');

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
      return jwt.verify(auth.slice(7), WEB_JWT_SECRET) as JwtPayload;
    } catch {
      return null;
    }
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
    createWebUser({
      id,
      username,
      password_hash,
      created_at: new Date().toISOString(),
    });

    const token = jwt.sign({ sub: id, username }, WEB_JWT_SECRET, {
      expiresIn: '30d',
    });
    return this.json(res, 201, { token, username });
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

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return this.json(res, 401, { error: 'Invalid credentials' });

    const token = jwt.sign({ sub: user.id, username }, WEB_JWT_SECRET, {
      expiresIn: '30d',
    });
    return this.json(res, 200, { token, username });
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
      this.clients.set(sessionId, {
        ws,
        userId: payload.sub,
        username: payload.username,
        convId: null,
      });
      send({ type: 'auth_ok', username: payload.username });
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
