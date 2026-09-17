import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LANES_FILE = path.join(here, '..', 'config', 'lanes.json');
export const DEFAULT_POLICY_FILE = path.join(here, '..', 'config', 'policy.json');

export function loadLanes(file = process.env.TM_LANES || DEFAULT_LANES_FILE) {
  const lanes = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(lanes) || lanes.length === 0) throw new Error('lanes.json must be a non-empty array');
  for (const l of lanes) {
    if (!l.id || !l.name) throw new Error('each lane needs id and name');
    l.short ??= l.name;
    l.color ??= '#94a3b8';
  }
  return lanes;
}

export function loadPolicy(file = process.env.TM_POLICY || DEFAULT_POLICY_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
