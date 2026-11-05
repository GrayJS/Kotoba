import type { Subtitle } from '../src/shared';
export interface Transcript {
  session: string; id: number; japanese: string; endedAt: number;
  revision?: number; isFinal?: boolean; startedAt?: number; firstTextMs?: number; recognitionMs?: number; queueMs?: number;
  sourceLanguage?: string; targetLanguage?: string;
}
type Translate = (text: string, context: { japanese: string; chinese: string }[], signal: AbortSignal, sourceLanguage?: string) => Promise<string>;
export class TranslationQueue {
  private session: string | null = null;
  private pending: Transcript[] = [];
  private context: { id: number; japanese: string; chinese: string }[] = [];
  private cache = new Map<number, { japanese: string; chinese: string }>();
  private controller: AbortController | null = null;
  private busy = false;
  constructor(private translate: Translate, private result: (s: Subtitle) => void, private dropped: () => void) {}
  reset(session: string | null) {
    this.session = session; this.pending = []; this.context = []; this.cache.clear(); this.controller?.abort();
  }
  add(transcript: Transcript) {
    if (transcript.session !== this.session) return;
    const existing = this.pending.findIndex(item => item.id === transcript.id);
    if (existing >= 0) {
      if ((transcript.revision ?? 1) > (this.pending[existing].revision ?? 1)) this.pending[existing] = transcript;
      return;
    }
    // Superseded previews must never accumulate behind subsequent speech.
    this.pending = this.pending.filter(item => item.isFinal !== false || item.id >= transcript.id);
    if (this.pending.length >= 3) { this.pending.shift(); this.dropped(); }
    this.pending.push(transcript); void this.pump();
  }
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.length) {
        const item = this.pending.shift()!;
        if (item.session !== this.session) continue;
        this.controller = new AbortController();
        const started = performance.now();
        let chinese = ''; let error: string | undefined;
        try {
          const cached = this.cache.get(item.id);
          chinese = cached?.japanese === item.japanese ? cached.chinese : (await this.translate(item.japanese, this.context.filter(c => c.id < item.id).map(({ japanese, chinese }) => ({ japanese, chinese })), this.controller.signal, item.sourceLanguage)).trim();
          if (!chinese) throw new Error('模型返回了空译文');
        } catch (e) {
          if (this.controller.signal.aborted || item.session !== this.session) continue;
          error = e instanceof Error ? e.message : '翻译失败';
        }
        if (item.session !== this.session) continue;
        if (!error) {
          this.cache.set(item.id, { japanese: item.japanese, chinese });
          while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value!);
          if (item.isFinal !== false) this.context = [...this.context.filter(c => c.id !== item.id), { id: item.id, japanese: item.japanese, chinese }].sort((a, b) => a.id - b.id).slice(-2);
        }
        this.result({ ...item, chinese, error, translatedRevision: item.revision ?? 1, translationPending: false,
          translationMs: Math.round(performance.now() - started), latencyMs: Math.max(0, Date.now() - item.endedAt) });
      }
    } finally { this.busy = false; }
  }
}
export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]);
}
