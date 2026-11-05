import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiveTranscript, receiveTranslation } from '../electron/subtitles';
const item = (revision: number, japanese: string, isFinal = false) => ({ session: 'a', id: 1, revision, japanese, isFinal, endedAt: 100, firstTextMs: 800 });
test('Japanese is visible immediately and retains the prior translation during revision', () => {
  let subtitle = receiveTranscript(null, item(1, '今日は'));
  assert.equal(subtitle.japanese, '今日は'); assert.equal(subtitle.translationPending, true);
  subtitle = receiveTranslation(subtitle, { ...item(1, '今日は'), chinese: '今天', latencyMs: 120 });
  subtitle = receiveTranscript(subtitle, item(2, '今日は晴れです'));
  assert.equal(subtitle.japanese, '今日は晴れです'); assert.equal(subtitle.chinese, '今天'); assert.equal(subtitle.translationPending, true);
  subtitle = receiveTranslation(subtitle, { ...item(1, '今日は'), chinese: '今天', latencyMs: 130 });
  assert.equal(subtitle.japanese, '今日は晴れです');
  subtitle = receiveTranscript(subtitle, item(3, '今日は晴れです。', true));
  subtitle = receiveTranslation(subtitle, { ...item(3, '今日は晴れです。', true), chinese: '今天是晴天。', latencyMs: 150 });
  assert.equal(subtitle.translationPending, false); assert.equal(subtitle.isFinal, true);
});
test('late results never rewind newer sentences or newer translated revisions', () => {
  const current = { ...item(3, '新しい文'), id: 2, chinese: '新句子', translatedRevision: 3, latencyMs: 10 };
  assert.equal(receiveTranslation(current, { ...item(9, '前の文'), chinese: '上一句', latencyMs: 30 }), current);
  assert.equal(receiveTranscript(current, item(10, '前の文')), current);
  assert.equal(receiveTranslation(current, { ...item(2, '旧文'), id: 2, chinese: '旧译文', latencyMs: 30 }), current);
});
