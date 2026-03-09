import fs from 'fs';
import path from 'path';

import { USERS_DIR } from './config.js';

// Only allow UUID-style or alphanumeric+hyphen userIds (prevents path traversal)
const VALID_USER_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function ensureUserDataDir(userId: string): string {
  if (!VALID_USER_ID.test(userId)) {
    throw new Error(`Invalid userId format: ${userId}`);
  }
  const userDir = path.join(USERS_DIR, userId);
  fs.mkdirSync(path.join(userDir, 'files'), { recursive: true });
  const memoryPath = path.join(userDir, 'memory.md');
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, `# User Memory\n`);
  }
  return userDir;
}

export function getUserDataDir(userId: string): string {
  return path.join(USERS_DIR, userId);
}
