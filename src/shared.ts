export type Device = 'cuda' | 'cpu';
export const SOURCE_LANGUAGES = { auto: '自动检测', ja: '日语', en: '英语', zh: '中文', ko: '韩语', es: '西班牙语', fr: '法语', de: '德语', ru: '俄语', pt: '葡萄牙语', it: '意大利语', ar: '阿拉伯语', hi: '印地语' } as const;
export const TARGET_LANGUAGES = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', en: 'English', ko: '한국어', es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский', pt: 'Português', it: 'Italiano', ar: 'العربية', hi: 'हिन्दी' } as const;
export interface Languages { source: keyof typeof SOURCE_LANGUAGES; target: keyof typeof TARGET_LANGUAGES }
export interface ServiceSettings {
  provider: 'ollama' | 'compatible';
  ollama: { baseUrl: string; model: string; timeoutMs: number; keepAlive: string };
  compatible: { baseUrl: string; model: string; timeoutMs: number };
}
export interface ServiceUpdate extends ServiceSettings { apiKey?: string; clearKey?: boolean }
export interface AudioApp { pid: number; name: string; title: string; active: boolean }
export interface Settings {
  device: Device; fontSize: number; opacity: number; width: number; bilingual: boolean;
  overlayVisible: boolean; editMode: boolean; liveSubtitles: boolean; theme: 'system' | 'light' | 'dark'; bounds?: { x: number; y: number };
}
export interface Subtitle {
  session: string; id: number; japanese: string; chinese: string;
  endedAt: number; latencyMs: number; error?: string;
  revision?: number; isFinal?: boolean; translatedRevision?: number; translationPending?: boolean;
  sourceLanguage?: string; targetLanguage?: string;
  startedAt?: number; firstTextMs?: number; firstChineseMs?: number; recognitionMs?: number; translationMs?: number; queueMs?: number;
}
export interface SetupProgress { stage: string; label: string; percent?: number; error?: string; busy: boolean }
export interface UpdateState {
  currentVersion: string; status: 'idle' | 'checking' | 'latest' | 'available' | 'error'; message: string;
  version?: string; prerelease?: boolean; releaseUrl?: string; downloadUrl?: string;
}
export interface AppState {
  settings: Settings; running: boolean; session: string | null; selectedApp: AudioApp | null;
  status: string; level: number; subtitle: Subtitle | null; history: Subtitle[]; setup: SetupProgress;
  ready: boolean; gpuChecked: boolean; deviceChecked: Device | null; warning: string | null;
  configPath: string; modelPath: string; ollamaUrl: string; ollamaModel: string;
  download: SetupProgress & { prepared: boolean };
  update: UpdateState;
  languages: Languages; service: ServiceSettings & { hasKey: boolean; local: boolean }; resolvedTheme: 'light' | 'dark';
  metrics: { count: number; p50: number; p95: number; dropped: number; firstTextMs?: number; firstChineseMs?: number; recognitionMs?: number; translationMs?: number; queueMs?: number };
}
export interface Bridge {
  getState(): Promise<AppState>; listApps(): Promise<AudioApp[]>;
  start(app: AudioApp): Promise<void>; stop(): Promise<void>; openConfig(): Promise<void>;
  checkDevice(): Promise<void>; updateSettings(patch: Partial<Settings>): Promise<void>;
  resetPosition(): Promise<void>; openModels(): Promise<void>;
  downloadModel(): Promise<void>; saveLanguages(languages: Languages): Promise<void>; saveService(service: ServiceUpdate): Promise<void>;
  overlayRegions(regions: { x: number; y: number; width: number; height: number }[]): Promise<void>;
  dragOverlay(phase: 'start' | 'move' | 'end'): Promise<void>;
  checkUpdates(): Promise<void>; openUpdate(target: 'release' | 'download'): Promise<void>;
  onState(callback: (state: AppState) => void): () => void;
}
export const DEFAULT_SETTINGS: Settings = { device: 'cuda', fontSize: 28, opacity: 0.68, width: 1000, bilingual: true, overlayVisible: true, editMode: false, liveSubtitles: true, theme: 'system' };
declare global { interface Window { kotoba: Bridge } }
