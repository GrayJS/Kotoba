import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationQueue, percentile } from '../electron/pipeline';
import type { Subtitle } from '../src/shared';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const transcript = (session: string, id: number) => ({ session, id, japanese: `日文${id}`, endedAt: Date.now() - 10 });
test('serializes translation and only retains the two most recent context pairs', async () => {
  const contexts: unknown[] = []; const output: Subtitle[] = [];
  const q = new TranslationQueue(async (text, context) => { contexts.push(context); return '中' + text; }, item => output.push(item), () => {});
  q.reset('a'); q.add(transcript('a', 1)); await tick();
  q.add(transcript('a', 2)); await tick(); q.add(transcript('a', 3)); await tick(); q.add(transcript('a', 4)); await tick();
  assert.deepEqual(output.map(i => i.id), [1, 2, 3, 4]);
  assert.deepEqual((contexts[3] as any[]).map(c => c.japanese), ['日文2', '日文3']);
});
test('bounds waiting queue to three and drops oldest pending sentences', async () => {
  let release!: (text: string) => void; let calls = 0; let drops = 0; const ids: number[] = [];
  const q = new TranslationQueue(async () => ++calls === 1 ? new Promise<string>(resolve => { release = resolve; }) : '译文', item => ids.push(item.id), () => drops++);
  q.reset('a'); for (let i = 1; i <= 6; i++) q.add(transcript('a', i));
  release('译文'); await tick();
  assert.equal(drops, 2); assert.deepEqual(ids, [1, 4, 5, 6]);
});
test('aborts old-session requests and discards stale results when switching apps', async () => {
  let release!: (text: string) => void; const ids: number[] = []; let aborted = false;
  const q = new TranslationQueue(async (_text, _context, signal) => {
    if (!release) { signal.addEventListener('abort', () => { aborted = true; }); return new Promise<string>(resolve => { release = resolve; }); }
    return '新会话';
  }, item => ids.push(item.id), () => {});
  q.reset('a'); q.add(transcript('a', 1)); q.reset('b'); q.add(transcript('a', 2)); q.add(transcript('b', 3));
  release('旧结果'); await tick(); assert.equal(aborted, true); assert.deepEqual(ids, [3]);
});
test('translation errors retain Japanese and do not contaminate context', async () => {
  const output: Subtitle[] = []; let seenContext = -1;
  const q = new TranslationQueue(async (_text, context) => { if (!output.length) throw new Error('连接失败'); seenContext = context.length; return '恢复'; }, item => output.push(item), () => {});
  q.reset('a'); q.add(transcript('a', 1)); await tick(); q.add(transcript('a', 2)); await tick();
  assert.equal(output[0].japanese, '日文1'); assert.equal(output[0].chinese, ''); assert.equal(output[0].error, '连接失败'); assert.equal(seenContext, 0);
});
test('latency percentiles use nearest-rank over measured samples', () => {
  assert.equal(percentile([], .5), 0); assert.equal(percentile([4000, 1000, 3000, 2000], .5), 2000); assert.equal(percentile([4000, 1000, 3000, 2000], .95), 4000);
});
test('coalesces previews and only commits final sentences to translation context', async () => {
  let release!: (text: string) => void;
  let calls = 0;
  const revisions: number[] = []; const contexts: any[] = [];
  const q = new TranslationQueue(async (_text, context) => {
    contexts.push(context);
    if (++calls === 1) return new Promise<string>(resolve => { release = resolve; });
    return '晴天';
  }, item => revisions.push(item.revision!), () => { throw new Error('Coalescing is not a dropped sentence'); });
  q.reset('a');
  q.add({ ...transcript('a', 1), revision: 1, isFinal: false });
  for (let i = 2; i <= 8; i++) q.add({ ...transcript('a', 1), japanese: `日文修订${i}`, revision: i, isFinal: i === 8 });
  release('今天'); await tick();
  assert.deepEqual(revisions, [1, 8]); assert.equal(contexts[1].length, 0);
  q.add({ ...transcript('a', 2), revision: 1, isFinal: false }); await tick();
  assert.equal(contexts[2][0].japanese, '日文修订8');
});
test('reuses an unchanged preview translation when finalizing the sentence', async () => {
  let calls = 0; const finals: boolean[] = [];
  const q = new TranslationQueue(async () => { calls++; return '今天'; }, item => finals.push(item.isFinal!), () => {});
  q.reset('a'); q.add({ ...transcript('a', 1), revision: 1, isFinal: false }); await tick();
  q.add({ ...transcript('a', 1), revision: 2, isFinal: true }); await tick();
  assert.equal(calls, 1); assert.deepEqual(finals, [false, true]);
});
