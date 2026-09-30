import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrivacyPayload,
  buildSummaryBatchPayload,
  estimateTokens,
  RAW_FLOOR_LIMIT,
  REMOTE_INPUT_TOKEN_LIMIT,
} from '../core/privacy-payload.js';

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
    rawFloorLimit: 5,
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
  const payload = buildPrivacyPayload({ chat, targetFloorIndex: 5, rollingSummary: '', rawFloorLimit: 5 });
  assert.deepEqual(payload.recentFloors.map((row) => row.floor), [2, 3, 4, 5, 6]);
  assert.equal(JSON.stringify(payload).includes('floor-7'), false);
});

test('default remote payload sends no raw chat floors', () => {
  const chat = Array.from({ length: 6 }, (_, index) => ({ mes: `PRIVATE_RAW_${index + 1}` }));
  const payload = buildPrivacyPayload({ chat, targetFloorIndex: 5, rollingSummary: 'SAFE_SUMMARY' });
  assert.deepEqual(payload.recentFloors, []);
  assert.equal(payload.policy.rawFloorLimit, 0);
  assert.equal(JSON.stringify(payload).includes('PRIVATE_RAW_'), false);
});

test('floor summarization includes only the current floor when history sending is disabled', () => {
  const chat = Array.from({ length: 6 }, (_, index) => ({ mes: `RAW_${index + 1}` }));
  const payload = buildPrivacyPayload({
    chat,
    targetFloorIndex: 5,
    rollingSummary: 'SAFE_SUMMARY',
    rawFloorLimit: 0,
    includeTargetFloor: true,
  });
  assert.deepEqual(payload.recentFloors.map((row) => row.floor), [6]);
  assert.equal(payload.recentFloors[0].text, 'RAW_6');
  assert.equal(JSON.stringify(payload).includes('RAW_5'), false);
  assert.equal(payload.policy.targetFloorIncludedForSummary, true);
});

test('privacy payload enforces a hard remote input token budget', () => {
  const huge = '很长的内容'.repeat(12000);
  const payload = buildPrivacyPayload({
    chat: [{ mes: huge }],
    targetFloorIndex: 0,
    rollingSummary: huge,
    rawFloorLimit: 5,
  });
  const contentTokens = estimateTokens(payload.rollingSummary)
    + payload.recentFloors.reduce((total, floor) => total + estimateTokens(floor.text), 0);
  assert.ok(contentTokens <= REMOTE_INPUT_TOKEN_LIMIT);
  assert.equal(payload.policy.contentTruncated, true);
  assert.equal(payload.policy.maxInputTokens, REMOTE_INPUT_TOKEN_LIMIT);
});

test('batch summary payload includes only its target floors', () => {
  const chat = Array.from({ length: 12 }, (_, index) => ({ mes: `PRIVATE_FLOOR_${index + 1}` }));
  const payload = buildSummaryBatchPayload({
    chat,
    floorIndexes: [7, 8, 9],
    rollingSummary: 'SAFE_ROLLING_SUMMARY',
  });
  assert.deepEqual(payload.targetFloors.map((row) => row.floor), [8, 9, 10]);
  const serialized = JSON.stringify(payload);
  for (const floor of [1, 2, 3, 4, 5, 6, 7, 11, 12]) {
    assert.equal(serialized.includes(`PRIVATE_FLOOR_${floor}\"`), false);
  }
  for (const floor of [8, 9, 10]) assert.equal(serialized.includes(`PRIVATE_FLOOR_${floor}\"`), true);
  assert.equal(payload.policy.olderRawFloorsIncluded, false);
});

test('oversized target floors require splitting instead of accepting truncated input', () => {
  const huge = '很长的楼层内容'.repeat(4000);
  assert.throws(() => buildSummaryBatchPayload({
    chat: Array.from({ length: 20 }, () => ({ mes: huge })),
    floorIndexes: Array.from({ length: 20 }, (_, index) => index),
    rollingSummary: huge,
  }), /分批或分段/);
});
