import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAccessibility, readAccessibility } from '../src/js/core/accessibility.js';

test('accessibility settings are clamped, saved and applied to the page', () => {
  const values = new Map(), root = { dataset: {}, style: {} };
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  globalThis.document = { documentElement: root };
  try {
    values.set('noai.accessibility', JSON.stringify({ textSize: 400, vision: 'purple', contrast: 'yes' }));
    assert.deepEqual(readAccessibility(), { textSize: 150, vision: 'default', contrast: false, motion: false });
    applyAccessibility({ textSize: 112, vision: 'red-green', contrast: true, motion: true });
    assert.equal(readAccessibility().textSize, 110);
    assert.equal(root.dataset.vision, 'red-green');
    assert.equal(root.dataset.contrast, 'more');
    assert.equal(root.dataset.motion, 'reduce');
    assert.equal(root.style.zoom, '1.1');
    applyAccessibility({ vision: 'default', contrast: false, motion: false, textSize: 100 });
    assert.equal(root.dataset.vision, undefined);
    assert.equal(root.style.zoom, '');
  } finally { delete globalThis.localStorage; delete globalThis.document; }
});
