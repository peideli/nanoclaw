import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SESSION_TOKEN_THRESHOLD,
  TRIGGER_PATTERN,
  WEB_ENABLED,
  WEB_PORT,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { WebChatChannel } from './channels/webchat.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRecentMessageSummary,
  getRouterState,
  getSessionCumulativeTokens,
  getWindowedMessagesSince,
  initDatabase,
  logAudit,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startAsyncWatcher } from './async-watcher.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatMessagesWithWindow,
  formatOutbound,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  isClassifierEnabled,
  shouldRotateForNewTask,
} from './task-classifier.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

const MEMORY_EXTRACTION_PROMPT =
  '[SYSTEM: Session is ending. Please update /workspace/user/memory.md with important new information from this conversation. Include decisions, preferences, ongoing tasks, and technical details. Keep it concise. Do not remove existing content unless clearly outdated.]';

/**
 * Rotate the session for a group: extract memory, close container, clear session state.
 */
async function rotateSession(
  group: RegisteredGroup,
  chatJid: string,
  reason: string,
): Promise<void> {
  logger.info(
    { group: group.folder, reason },
    'Rotating session',
  );

  // Memory extraction: if the user has a userId (Web Chat) and container is active,
  // send the extraction prompt and wait for it to finish.
  if (group.userId && queue.sendMessage(chatJid, MEMORY_EXTRACTION_PROMPT)) {
    logger.debug({ group: group.folder }, 'Sent memory extraction prompt');
    const idle = await queue.waitForIdle(chatJid, 30000);
    if (!idle) {
      logger.warn(
        { group: group.folder },
        'Memory extraction timed out after 30s',
      );
    }
  }

  // Close the container
  queue.closeStdin(chatJid);

  // Clear in-memory session
  delete sessions[group.folder];

  // Clear DB session
  deleteSession(group.folder);

  // Log audit event
  logAudit({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    user_id: group.userId ?? null,
    channel: null,
    chat_jid: chatJid,
    action: 'session_rotated',
    detail: JSON.stringify({ group: group.folder, reason }),
    token_input: null,
    token_output: null,
    session_id: null,
    duration_ms: null,
  });
}

/**
 * Check if the session should be rotated due to token accumulation.
 * Called after runAgent completes.
 */
async function checkTokenThreshold(
  group: RegisteredGroup,
  chatJid: string,
): Promise<void> {
  const cumulative = getSessionCumulativeTokens(group.folder);
  if (cumulative >= SESSION_TOKEN_THRESHOLD) {
    logger.info(
      { group: group.folder, cumulative, threshold: SESSION_TOKEN_THRESHOLD },
      'Token threshold exceeded, rotating session',
    );
    await rotateSession(group, chatJid, `token_threshold_${cumulative}`);
  }
}

/**
 * Check classifier to see if a new message starts a new task.
 * If so, rotate the session before processing.
 */
async function checkClassifierBeforeRun(
  group: RegisteredGroup,
  chatJid: string,
  newMessageText: string,
): Promise<boolean> {
  if (!isClassifierEnabled()) return false;
  if (!sessions[group.folder]) return false; // No existing session to rotate

  const recentHistory = getRecentMessageSummary(chatJid, 5);
  const shouldRotate = await shouldRotateForNewTask(
    recentHistory,
    newMessageText,
  );

  if (shouldRotate) {
    await rotateSession(group, chatJid, 'classifier_new_task');
  }

  return shouldRotate;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const windowed = getWindowedMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (windowed.messages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = windowed.messages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessagesWithWindow(windowed);

  // Check classifier: if this looks like a new task, rotate session first
  const lastMessage = windowed.messages[windowed.messages.length - 1];
  await checkClassifierBeforeRun(group, chatJid, lastMessage.content);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    windowed.messages[windowed.messages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: windowed.messages.length,
      droppedCount: windowed.droppedCount,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, rotating session',
      );
      rotateSession(group, chatJid, 'idle_timeout').catch((err) =>
        logger.error({ group: group.name, err }, 'Error rotating session on idle'),
      );
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Determine channel name for audit logging
  const auditChannel = channel.name;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, {
    messageCount: windowed.messages.length,
    droppedCount: windowed.droppedCount,
    channel: auditChannel,
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  // Check if token threshold exceeded after successful run
  await checkTokenThreshold(group, chatJid);

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  auditMeta?: { messageCount: number; droppedCount: number; channel?: string },
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];
  const agentStartTime = Date.now();

  // Log agent_invoked audit event
  const auditSessionId = crypto.randomUUID();
  logAudit({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    user_id: group.userId ?? null,
    channel: auditMeta?.channel ?? null,
    chat_jid: chatJid,
    action: 'agent_invoked',
    detail: JSON.stringify({
      group: group.folder,
      prompt_length: prompt.length,
      message_count: auditMeta?.messageCount ?? 0,
      dropped_count: auditMeta?.droppedCount ?? 0,
    }),
    token_input: null,
    token_output: null,
    session_id: auditSessionId,
    duration_ms: null,
  });

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID and accumulate token usage
  let totalTokenInput = 0;
  let totalTokenOutput = 0;
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.tokenInput) totalTokenInput += output.tokenInput;
        if (output.tokenOutput) totalTokenOutput += output.tokenOutput;
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        userId: group.userId,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }
    if (output.tokenInput) totalTokenInput += output.tokenInput;
    if (output.tokenOutput) totalTokenOutput += output.tokenOutput;

    const durationMs = Date.now() - agentStartTime;
    const status = output.status === 'error' ? 'error' : 'success';

    // Log agent_completed audit event
    logAudit({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      user_id: group.userId ?? null,
      channel: auditMeta?.channel ?? null,
      chat_jid: chatJid,
      action: 'agent_completed',
      detail: JSON.stringify({
        group: group.folder,
        status,
        output_sent: !!output.result,
      }),
      token_input: totalTokenInput || null,
      token_output: totalTokenOutput || null,
      session_id: auditSessionId,
      duration_ms: durationMs,
    });

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    const durationMs = Date.now() - agentStartTime;
    logAudit({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      user_id: group.userId ?? null,
      channel: auditMeta?.channel ?? null,
      chat_jid: chatJid,
      action: 'agent_completed',
      detail: JSON.stringify({
        group: group.folder,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }),
      token_input: totalTokenInput || null,
      token_output: totalTokenOutput || null,
      session_id: auditSessionId,
      duration_ms: durationMs,
    });
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPendingWindowed = getWindowedMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPendingWindowed.messages.length > 0
              ? allPendingWindowed.messages
              : groupMessages;
          const formatted =
            allPendingWindowed.messages.length > 0
              ? formatMessagesWithWindow(allPendingWindowed)
              : formatMessages(groupMessages);

          // Check classifier: if new task detected, rotate and enqueue fresh
          const lastMsg = messagesToSend[messagesToSend.length - 1];
          const classifierRotated = await checkClassifierBeforeRun(
            group,
            chatJid,
            lastMsg.content,
          );

          if (classifierRotated) {
            // Session was rotated — don't pipe to old container, enqueue for new one
            queue.enqueueMessageCheck(chatJid, group?.userId);
          } else if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] = lastMsg.timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid, group?.userId);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid, group.userId);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();

  if (WEB_ENABLED) {
    const webchat = new WebChatChannel({ registerGroup });
    channels.push(webchat);
    await webchat.connect();
    logger.info({ port: WEB_PORT }, 'WebChat channel started');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) =>
      whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  startAsyncWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn(
          { jid },
          'No channel owns JID, cannot send async notification',
        );
        return;
      }
      await channel.sendMessage(jid, text);
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
