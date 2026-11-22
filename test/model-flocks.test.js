import test from 'node:test';
import assert from 'node:assert/strict';
import { SPECIES, birdScale, formation, speciesFor } from '../src/js/components/model-flocks.js';

test('an agent always flies as the same species, chosen from its ID alone', () => {
  for (const id of ['a', 'some-agent', 'x9', 'plugin-thing']) {
    assert.equal(speciesFor(id), speciesFor(id));
    assert.ok(SPECIES.includes(speciesFor(id)));
  }
  const spread = new Set(Array.from({ length: 60 }, (_, i) => speciesFor(`agent-${i}`).name));
  assert.ok(spread.size > 2, 'different IDs get a variety of species');
});

test('models form a V: the first at the point, the rest alternating sides further back', () => {
  const spots = formation(5, 10);
  assert.deepEqual(spots[0], { x: -0, y: -0 });
  assert.deepEqual(spots.slice(1).map(spot => spot.x), [-10, -10, -20, -20]);
  assert.ok(spots[1].y > 0 && spots[2].y < 0);
  assert.equal(Math.abs(spots[3].y), 10);
  assert.deepEqual(formation(0, 10), []);
});

test('bird size follows 30-day usage, and unused models fly smallest', () => {
  assert.equal(birdScale(0, 100), .72);
  assert.equal(birdScale(0, 0), .72);
  assert.ok(birdScale(100, 100) > birdScale(25, 100));
  assert.ok(birdScale(1, 100) > birdScale(0, 100));
});
