import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, extractCodes, normalizeCode } from '../src/services/code.ts';

test('normalizes common JAV code separators and padding', () => {
  assert.equal(normalizeCode('adn 1'), 'ADN-001');
  assert.equal(normalizeCode('#abp_978'), 'ABP-978');
  assert.equal(normalizeCode('[star765]'), 'STAR-765');
  assert.equal(normalizeCode('not-a-code'), null);
});

test('extracts unique normalized codes from captions', () => {
  assert.deepEqual(extractCodes('ADN-001 and adn 001, plus ABP_978'), ['ADN-001', 'ABP-978']);
  assert.deepEqual(extractCodes('ordinary caption without a code'), []);
});

test('removes a leading code from a title without losing the remaining title', () => {
  assert.equal(cleanTitle('ADN-001 - Sample title', 'ADN-001'), 'Sample title');
  assert.equal(cleanTitle('', 'ADN-001'), 'ADN-001');
});
