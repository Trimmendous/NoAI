import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseOffsetTime } from '../src/js/core/schedule-time.js';

test('offset dates reject silent normalization and accept leap years and offsets', () => {
  for (const value of ['2027-02-29T12:00Z', '2028-02-30T12:00Z', '2027-04-31T12:00Z',
    '2027-01-01T24:00Z', '2027-01-01T12:60Z', '2027-01-01T12:00:60Z', '2027-01-01T12:00+24:00',
    '2027-01-01T12:00', '2027-01-01T12:00Zjunk', '0000-01-01T00:00Z']) assert.throws(() => parseOffsetTime(value), value);
  assert.equal(parseOffsetTime('2028-02-29T12:00:00.500+05:30'), Date.parse('2028-02-29T06:30Z') / 1000);
  assert.equal(parseOffsetTime('2027-11-07T01:30-05:00') - parseOffsetTime('2027-11-07T01:30-04:00'), 3600);
});

test('local times reject DST gaps and retain the first fold occurrence in New York', () => {
  const script = `import assert from 'node:assert/strict';
    import {parseLocalTime} from './src/js/core/schedule-time.js';
    assert.throws(() => parseLocalTime('2027-03-14T02:30'), /does not exist/);
    assert.throws(() => parseLocalTime('2027-02-29T12:00'), /calendar/);
    assert.equal(parseLocalTime('2027-03-14T03:30'), Date.parse('2027-03-14T07:30Z')/1000);
    assert.equal(parseLocalTime('2027-11-07T01:30'), Date.parse('2027-11-07T05:30Z')/1000);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {env:{...process.env,TZ:'America/New_York'}, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
