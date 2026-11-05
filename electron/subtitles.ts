import type { Subtitle } from '../src/shared';
import type { Transcript } from './pipeline';

/** Publish Japanese immediately, retaining the previous translation of the same sentence. */
export function receiveTranscript(current: Subtitle | null, item: Transcript): Subtitle {
  const revision = item.revision ?? 1;
  const same = current?.session === item.session && current.id === item.id;
  if (current?.session === item.session && (current.id > item.id || same && (current.revision ?? 1) >= revision)) return current;
  return {
    ...item, revision, chinese: same ? current.chinese : '',
    translatedRevision: same ? current.translatedRevision ?? 0 : 0,
    translationPending: true, latencyMs: same ? current.latencyMs : 0,
    translationMs: same ? current.translationMs : undefined,
    firstChineseMs: same ? current.firstChineseMs : undefined,
  };
}

/** A slow older revision may update its translation, but never roll Japanese backwards. */
export function receiveTranslation(current: Subtitle | null, result: Subtitle): Subtitle {
  if (!current || current.session !== result.session) return result;
  if (current.id > result.id) return current;
  if (current.id < result.id) return result;
  const revision = result.revision ?? 1;
  if ((current.translatedRevision ?? 0) > revision) return current;
  return {
    ...current, chinese: result.chinese, error: result.error, translatedRevision: revision,
    translationPending: revision < (current.revision ?? 1), latencyMs: result.latencyMs,
    translationMs: result.translationMs,
    firstChineseMs: current.firstChineseMs ?? (result.chinese && result.startedAt ? Math.max(0, Date.now() - result.startedAt) : undefined),
  };
}
