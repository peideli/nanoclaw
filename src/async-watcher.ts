import { exec } from 'child_process';
import { promisify } from 'util';

import { ASYNC_WATCH_POLL_INTERVAL } from './config.js';
import {
  getActiveAsyncWatches,
  updateAsyncWatch,
} from './db.js';
import { logger } from './logger.js';
import { AsyncCheckResult } from './types.js';

const execAsync = promisify(exec);

const CHECK_TIMEOUT_MS = 15000;

export interface AsyncWatcherDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

let watcherRunning = false;

export function startAsyncWatcher(deps: AsyncWatcherDeps): void {
  if (watcherRunning) {
    logger.debug('Async watcher already running, skipping duplicate start');
    return;
  }
  watcherRunning = true;

  const tick = async () => {
    try {
      const watches = getActiveAsyncWatches();
      const now = Date.now();

      for (const watch of watches) {
        // Respect per-watch poll interval
        if (watch.last_checked_at) {
          const lastCheck = new Date(watch.last_checked_at).getTime();
          if (now - lastCheck < watch.poll_interval_ms) continue;
        }

        // Check max_checks limit
        if (watch.max_checks !== null && watch.check_count >= watch.max_checks) {
          const errorMsg = `Task timed out after ${watch.check_count} checks`;
          updateAsyncWatch(watch.id, {
            status: 'failed',
            error: errorMsg,
          });

          const label = watch.label || watch.service;
          await deps.sendMessage(
            watch.chat_jid,
            `*${label}* -- task failed\n\n${errorMsg}`,
          ).catch((err) =>
            logger.error({ err, watchId: watch.id }, 'Failed to send timeout notification'),
          );

          logger.info({ watchId: watch.id, label }, 'Async watch timed out');
          continue;
        }

        // Execute check command
        let checkResult: AsyncCheckResult;
        try {
          const { stdout } = await execAsync(watch.check_command, {
            timeout: CHECK_TIMEOUT_MS,
            env: { ...process.env, HOME: process.env.HOME },
          });
          checkResult = JSON.parse(stdout.trim());
        } catch (err) {
          // Transient error — log and continue retrying
          updateAsyncWatch(watch.id, {
            last_checked_at: new Date().toISOString(),
            check_count: watch.check_count + 1,
          });
          logger.warn(
            { err, watchId: watch.id, checkCount: watch.check_count + 1 },
            'Async check command failed (transient)',
          );
          continue;
        }

        // Update check metadata
        updateAsyncWatch(watch.id, {
          last_checked_at: new Date().toISOString(),
          check_count: watch.check_count + 1,
        });

        if (checkResult.done) {
          // Task completed
          updateAsyncWatch(watch.id, {
            status: 'completed',
            result: JSON.stringify(checkResult),
          });

          const label = watch.label || watch.service;
          const summary = checkResult.summary || 'Task completed';
          const resultDir = checkResult.result_dir
            ? `\n\nResults saved to: ${checkResult.result_dir}`
            : '';

          await deps.sendMessage(
            watch.chat_jid,
            `*${label}* -- completed\n\n${summary}${resultDir}`,
          ).catch((err) =>
            logger.error({ err, watchId: watch.id }, 'Failed to send completion notification'),
          );

          logger.info(
            { watchId: watch.id, label, checkCount: watch.check_count + 1 },
            'Async watch completed',
          );
        } else if (checkResult.error) {
          // Check returned an error status
          updateAsyncWatch(watch.id, {
            status: 'failed',
            error: checkResult.error,
          });

          const label = watch.label || watch.service;
          await deps.sendMessage(
            watch.chat_jid,
            `*${label}* -- task failed\n\n${checkResult.error}`,
          ).catch((err) =>
            logger.error({ err, watchId: watch.id }, 'Failed to send error notification'),
          );

          logger.info({ watchId: watch.id, label }, 'Async watch failed with error from check');
        } else {
          logger.debug(
            { watchId: watch.id, checkCount: watch.check_count + 1 },
            'Async check: not done yet',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in async watcher tick');
    }

    setTimeout(tick, ASYNC_WATCH_POLL_INTERVAL);
  };

  tick();
  logger.info('Async watcher started');
}
