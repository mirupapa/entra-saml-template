import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_MS, ABSOLUTE_MS, nextExpiry } from './session-policy.js';
test('activity renews idle expiry without crossing eight-hour absolute expiry', () => {
  const login = 1000, absolute = login + ABSOLUTE_MS;
  assert.equal(nextExpiry(login + 50 * 60000, absolute), login + 110 * 60000);
  assert.equal(nextExpiry(absolute - 1000, absolute), absolute);
  assert.equal(IDLE_MS, 3600000); assert.equal(ABSOLUTE_MS, 28800000);
});
