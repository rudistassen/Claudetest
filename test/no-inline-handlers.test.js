import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The page's security rules (script-src 'self') block inline handlers such as onchange="…", so they silently
// do nothing in the live app. Everything has to be wired up with addEventListener instead.
test('no inline event handlers in the app’s HTML', () => {
  const files = [];
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.js') && files.push(join(dir, d.name))));
  walk('public/js');
  const found = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => [f, i + 1, line]))
    .filter(([, , line]) => /\son(click|change|input|submit|load|error|keydown|keyup|focus|blur)=["'`]/.test(line))
    .map(([f, n]) => `${f}:${n}`);
  assert.deepEqual(found, []);
});
