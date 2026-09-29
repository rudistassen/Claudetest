import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

// One stray or missing brace silently switches off the rules after it, so check the stylesheet is balanced.
test('the stylesheet has balanced braces', () => {
  const css = fs.readFileSync(new URL('../public/css/styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"[^"]*"|'[^']*'/g, '');
  let depth = 0;
  css.split('\n').forEach((line, i) => {
    for (const ch of line) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      assert.ok(depth >= 0, `extra } on line ${i + 1}`);
    }
  });
  assert.equal(depth, 0, 'a { is never closed');
});
