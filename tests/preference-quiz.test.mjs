import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPreferenceQuizComplete,
  PREFERENCE_QUIZ_ITEMS,
  PREFERENCE_QUIZ_SCALE,
  scorePreferenceQuiz,
  STORY_EXPERIENCE_OPTIONS,
} from '../core/preference-quiz.js';

test('preference quiz requires all ten answers and scores reversed items', () => {
  const answers = Object.fromEntries(PREFERENCE_QUIZ_ITEMS.map((item) => [item.id, item.reverse ? 1 : 5]));
  assert.equal(PREFERENCE_QUIZ_ITEMS.length, 10);
  assert.equal(isPreferenceQuizComplete(answers), true);
  assert.deepEqual(scorePreferenceQuiz(answers), {
    interaction: 100,
    relationship: 100,
    structure: 100,
    tension: 100,
    novelty: 100,
  });
  delete answers[PREFERENCE_QUIZ_ITEMS[0].id];
  assert.equal(isPreferenceQuizComplete(answers), false);
});

test('preference scale has explicit disagreement, neutral or unknown, and agreement labels', () => {
  assert.deepEqual(PREFERENCE_QUIZ_SCALE.map((item) => item.label), [
    '非常不同意',
    '比较不同意',
    '中立或不知道',
    '比较同意',
    '非常同意',
  ]);
});

test('story experience choices provide twelve stable multi-select ids', () => {
  assert.equal(STORY_EXPERIENCE_OPTIONS.length, 12);
  assert.equal(new Set(STORY_EXPERIENCE_OPTIONS.map((item) => item.id)).size, 12);
  assert.ok(STORY_EXPERIENCE_OPTIONS.some((item) => item.id === 'relationship'));
  assert.ok(STORY_EXPERIENCE_OPTIONS.some((item) => item.id === 'surprise'));
});
