import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteSession,
  deleteTask,
  getAuditLogs,
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getRecentMessageSummary,
  getSession,
  getSessionCumulativeTokens,
  getTaskById,
  getTokenUsageSummary,
  getWindowedMessagesSince,
  logAudit,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- getWindowedMessagesSince ---

describe('getWindowedMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    // Store 10 messages
    for (let i = 1; i <= 10; i++) {
      store({
        id: `w${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('returns all messages when count is below max', () => {
    const result = getWindowedMessagesSince('group@g.us', '', 'Andy', 20);
    expect(result.messages).toHaveLength(10);
    expect(result.droppedCount).toBe(0);
    expect(result.totalCount).toBe(10);
  });

  it('returns all messages when count equals max', () => {
    const result = getWindowedMessagesSince('group@g.us', '', 'Andy', 10);
    expect(result.messages).toHaveLength(10);
    expect(result.droppedCount).toBe(0);
    expect(result.totalCount).toBe(10);
  });

  it('truncates to most recent messages when count exceeds max', () => {
    const result = getWindowedMessagesSince('group@g.us', '', 'Andy', 3);
    expect(result.messages).toHaveLength(3);
    expect(result.droppedCount).toBe(7);
    expect(result.totalCount).toBe(10);
    // Should be the last 3 messages
    expect(result.messages[0].content).toBe('message 8');
    expect(result.messages[1].content).toBe('message 9');
    expect(result.messages[2].content).toBe('message 10');
  });

  it('returns empty when no messages match', () => {
    const result = getWindowedMessagesSince(
      'group@g.us',
      '2024-01-01T00:01:00.000Z',
      'Andy',
      50,
    );
    expect(result.messages).toHaveLength(0);
    expect(result.droppedCount).toBe(0);
    expect(result.totalCount).toBe(0);
  });

  it('uses default MAX_CONTEXT_MESSAGES when maxMessages not specified', () => {
    // Default is 50, and we only have 10 messages
    const result = getWindowedMessagesSince('group@g.us', '', 'Andy');
    expect(result.messages).toHaveLength(10);
    expect(result.droppedCount).toBe(0);
  });
});

// --- Audit log ---

describe('audit logs', () => {
  it('logs and retrieves an audit entry', () => {
    logAudit({
      id: 'audit-1',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: 'user-1',
      channel: 'whatsapp',
      chat_jid: 'group@g.us',
      action: 'agent_invoked',
      detail: JSON.stringify({ group: 'main', prompt_length: 100 }),
      token_input: null,
      token_output: null,
      session_id: 'sess-1',
      duration_ms: null,
    });

    const logs = getAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe('audit-1');
    expect(logs[0].action).toBe('agent_invoked');
    expect(logs[0].user_id).toBe('user-1');
  });

  it('filters by action', () => {
    logAudit({
      id: 'audit-2a',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'agent_invoked',
      detail: null,
      token_input: null,
      token_output: null,
      session_id: null,
      duration_ms: null,
    });
    logAudit({
      id: 'audit-2b',
      timestamp: '2024-01-01T00:00:02.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: null,
      token_input: 500,
      token_output: 200,
      session_id: null,
      duration_ms: 3000,
    });

    const invoked = getAuditLogs({ action: 'agent_invoked' });
    expect(invoked).toHaveLength(1);
    expect(invoked[0].id).toBe('audit-2a');

    const completed = getAuditLogs({ action: 'agent_completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe('audit-2b');
  });

  it('filters by userId', () => {
    logAudit({
      id: 'audit-3a',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: 'user-A',
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: null,
      token_input: 100,
      token_output: 50,
      session_id: null,
      duration_ms: 1000,
    });
    logAudit({
      id: 'audit-3b',
      timestamp: '2024-01-01T00:00:02.000Z',
      user_id: 'user-B',
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: null,
      token_input: 200,
      token_output: 100,
      session_id: null,
      duration_ms: 2000,
    });

    const logsA = getAuditLogs({ userId: 'user-A' });
    expect(logsA).toHaveLength(1);
    expect(logsA[0].user_id).toBe('user-A');
  });
});

// --- Token usage summary ---

describe('getTokenUsageSummary', () => {
  it('sums token usage from agent_completed entries', () => {
    logAudit({
      id: 'ts-1',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: 'user-1',
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: null,
      token_input: 1000,
      token_output: 500,
      session_id: null,
      duration_ms: 5000,
    });
    logAudit({
      id: 'ts-2',
      timestamp: '2024-01-01T00:00:02.000Z',
      user_id: 'user-1',
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: null,
      token_input: 2000,
      token_output: 800,
      session_id: null,
      duration_ms: 3000,
    });
    // agent_invoked should not count
    logAudit({
      id: 'ts-3',
      timestamp: '2024-01-01T00:00:03.000Z',
      user_id: 'user-1',
      channel: null,
      chat_jid: null,
      action: 'agent_invoked',
      detail: null,
      token_input: null,
      token_output: null,
      session_id: null,
      duration_ms: null,
    });

    const summary = getTokenUsageSummary();
    expect(summary.total_input).toBe(3000);
    expect(summary.total_output).toBe(1300);
    expect(summary.invocation_count).toBe(2);
  });

  it('filters by userId', () => {
    logAudit({
      id: 'tsu-1',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: 'user-A',
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: null,
      token_input: 1000,
      token_output: 500,
      session_id: null,
      duration_ms: 5000,
    });
    logAudit({
      id: 'tsu-2',
      timestamp: '2024-01-01T00:00:02.000Z',
      user_id: 'user-B',
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: null,
      token_input: 3000,
      token_output: 1000,
      session_id: null,
      duration_ms: 4000,
    });

    const summaryA = getTokenUsageSummary({ userId: 'user-A' });
    expect(summaryA.total_input).toBe(1000);
    expect(summaryA.total_output).toBe(500);
    expect(summaryA.invocation_count).toBe(1);
  });

  it('returns zeros when no matching entries', () => {
    const summary = getTokenUsageSummary();
    expect(summary.total_input).toBe(0);
    expect(summary.total_output).toBe(0);
    expect(summary.invocation_count).toBe(0);
  });
});

// --- deleteSession ---

describe('deleteSession', () => {
  it('deletes an existing session', () => {
    setSession('main', 'sess-123');
    expect(getSession('main')).toBe('sess-123');

    deleteSession('main');
    expect(getSession('main')).toBeUndefined();
  });

  it('is a no-op for non-existent session', () => {
    deleteSession('nonexistent');
    expect(getSession('nonexistent')).toBeUndefined();
  });
});

// --- getSessionCumulativeTokens ---

describe('getSessionCumulativeTokens', () => {
  it('sums tokens from agent_completed events for the group', () => {
    logAudit({
      id: 'sct-1',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: JSON.stringify({ group: 'main', status: 'success' }),
      token_input: 5000,
      token_output: 2000,
      session_id: null,
      duration_ms: 1000,
    });
    logAudit({
      id: 'sct-2',
      timestamp: '2024-01-01T00:00:02.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: JSON.stringify({ group: 'main', status: 'success' }),
      token_input: 3000,
      token_output: 1000,
      session_id: null,
      duration_ms: 2000,
    });

    const total = getSessionCumulativeTokens('main');
    expect(total).toBe(11000); // 5000+2000+3000+1000
  });

  it('resets after session_rotated event', () => {
    // Tokens before rotation
    logAudit({
      id: 'sct-3',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: JSON.stringify({ group: 'main', status: 'success' }),
      token_input: 10000,
      token_output: 5000,
      session_id: null,
      duration_ms: 1000,
    });

    // Rotation event
    logAudit({
      id: 'sct-4',
      timestamp: '2024-01-01T00:00:02.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'session_rotated',
      detail: JSON.stringify({ group: 'main', reason: 'test' }),
      token_input: null,
      token_output: null,
      session_id: null,
      duration_ms: null,
    });

    // Tokens after rotation
    logAudit({
      id: 'sct-5',
      timestamp: '2024-01-01T00:00:03.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: JSON.stringify({ group: 'main', status: 'success' }),
      token_input: 1000,
      token_output: 500,
      session_id: null,
      duration_ms: 500,
    });

    const total = getSessionCumulativeTokens('main');
    expect(total).toBe(1500); // Only counts after rotation
  });

  it('returns 0 when no matching events', () => {
    expect(getSessionCumulativeTokens('main')).toBe(0);
  });

  it('does not count tokens from other groups', () => {
    logAudit({
      id: 'sct-6',
      timestamp: '2024-01-01T00:00:01.000Z',
      user_id: null,
      channel: null,
      chat_jid: null,
      action: 'agent_completed',
      detail: JSON.stringify({ group: 'other-group', status: 'success' }),
      token_input: 9999,
      token_output: 9999,
      session_id: null,
      duration_ms: 1000,
    });

    expect(getSessionCumulativeTokens('main')).toBe(0);
  });
});

// --- getRecentMessageSummary ---

describe('getRecentMessageSummary', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 8; i++) {
      store({
        id: `rms-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: `User${i}`,
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('returns last N messages in chronological order', () => {
    const summary = getRecentMessageSummary('group@g.us', 3);
    expect(summary).toContain('User6: message 6');
    expect(summary).toContain('User7: message 7');
    expect(summary).toContain('User8: message 8');
    expect(summary).not.toContain('User5');
    // Check chronological order
    const lines = summary.split('\n');
    expect(lines[0]).toContain('message 6');
    expect(lines[2]).toContain('message 8');
  });

  it('returns empty string for no messages', () => {
    expect(getRecentMessageSummary('nonexistent@g.us', 5)).toBe('');
  });

  it('truncates long message content', () => {
    store({
      id: 'rms-long',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'Long',
      content: 'x'.repeat(500),
      timestamp: '2024-01-01T00:01:00.000Z',
    });
    const summary = getRecentMessageSummary('group@g.us', 1);
    // Should be truncated to 200 chars for content
    expect(summary.length).toBeLessThan(300);
  });
});
