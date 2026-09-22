import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ENV_FILE = path.join(here, '..', '.env.local');

// Node 22's built-in dotenv loader keeps explicitly exported environment
// variables authoritative and avoids adding a runtime dependency.
export function loadLocalEnv(file = DEFAULT_ENV_FILE) {
  if (!existsSync(file)) return false;
  if (typeof process.loadEnvFile !== 'function') throw new Error('Node.js process.loadEnvFile is required to read .env.local');
  process.loadEnvFile(file);
  return true;
}
