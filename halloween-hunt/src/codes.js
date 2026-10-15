import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

// HUNT_CODES looks like "cauldron=Xk3vT9qLmR,bookshelf=..." (commas or new lines).
export function parseCodes(raw) {
  const codes = new Map();
  for (const entry of String(raw ?? '').split(/[,\n]/)) {
    if (!entry.trim()) continue;
    const i = entry.indexOf('=');
    if (i < 1) throw new Error(`HUNT_CODES entry "${entry.trim()}" should look like checkpoint-id=code`);
    codes.set(entry.slice(0, i).trim(), entry.slice(i + 1).trim());
  }
  return codes;
}

// Returns the config with each checkpoint's secret code filled in.
export function withCodes(config, codes) {
  const ids = new Set(config.checkpoints.map((c) => c.id));
  const unknown = [...codes.keys()].filter((id) => !ids.has(id));
  if (unknown.length) throw new Error(`HUNT_CODES has codes for checkpoints that aren't in hunt.config.js: ${unknown.join(', ')}`);
  const missing = config.checkpoints.filter((c) => !codes.get(c.id)).map((c) => c.id);
  if (missing.length) throw new Error(`HUNT_CODES is missing codes for: ${missing.join(', ')}`);
  return { ...config, checkpoints: config.checkpoints.map((c) => ({ ...c, code: codes.get(c.id) })) };
}

export function makeCodes(config) {
  const code = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return config.checkpoints.map((c) => `${c.id}=${code()}`).join(',');
}
