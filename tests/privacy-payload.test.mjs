import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrivacyPayload, RAW_FLOOR_LIMIT } from '../core/privacy-payload.js';

test('remote payload contains only rolling summary and the latest five raw floors', () => {
  const chat = Array.from({ length: 12 }, (_, index) => ({
    is_user: index % 2 === 0,
    name: index % 2 === 0 ? '玩家' : '角色',
    mes: `UNIQUE_RAW_FLOOR_${index + 1}`,
  }));
  const payload = buildPrivacyPayload({
    chat,
    targetFloorIndex: 11,
    rollingSummary: 'SAFE_ROLLING_SUMMARY',
  });
  assert.equal(RAW_FLOOR_LIMIT, 5);
  assert.deepEqual(payload.recentFloors.map((row) => row.floor), [8, 9, 10, 11, 12]);
  assert.equal(payload.rollingSummary, 'SAFE_ROLLING_SUMMARY');
  assert.equal(payload.recentFloors[0].importance, 'normal');
  assert.equal(payload.recentFloors[1].importance, 'player-statement');
  const serialized = JSON.stringify(payload);
  for (let floor = 1; floor <= 7; floor += 1) {
    assert.equal(serialized.includes(`UNIQUE_RAW_FLOOR_${floor}\"`), false);
  }
  for (let floor = 8; floor <= 12; floor += 1) {
    assert.equal(serialized.includes(`UNIQUE_RAW_FLOOR_${floor}\"`), true);
  }
  assert.equal(payload.policy.olderRawFloorsIncluded, false);
});

test('payload never includes floors newer than the requested target', () => {
  const chat = Array.from({ length: 10 }, (_, index) => ({ mes: `floor-${index + 1}` }));
  const payload = buildPrivacyPayload({ chat, targetFloorIndex: 5, rollingSummary: '' });
  assert.deepEqual(payload.recentFloors.map((row) => row.floor), [2, 3, 4, 5, 6]);
  assert.equal(JSON.stringify(payload).includes('floor-7'), false);
});
