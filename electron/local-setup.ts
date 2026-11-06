import type { Config } from './config';
import type { LocalSetupState } from '../src/shared';

export const INDEX_MODEL = 'hf.co/IndexTeam/Index-Translate-2B-GGUF:Q4_K_M';
export const LOCAL_OLLAMA_URL = 'http://127.0.0.1:11434';
export const INITIAL_LOCAL_SETUP: LocalSetupState = { status: 'idle', busy: false, eligible: false, hasRuntime: false, hasModel: false, stage: 'detect', label: '等待检测本机翻译环境' };
export type SetupProgress = { stage: string; label: string; percent?: number; completedBytes?: number; totalBytes?: number };
export function defaultLocalConfiguration(config: Config): boolean {
  const url = new URL(config.ollama.baseUrl);
  return config.translation.provider === 'ollama' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.protocol === 'http:' && url.port === '11434' && ['/', ''].includes(url.pathname) && config.ollama.model === INDEX_MODEL;
}
export interface LocalSetupDependencies {
  configuration(): Config;
  probe(signal: AbortSignal): Promise<{ hasModel: boolean }>;
  findRuntime(): Promise<string | null>;
  installRuntime(progress: (p: SetupProgress) => void, signal: AbortSignal): Promise<string>;
  startRuntime(executable: string, signal: AbortSignal): Promise<void>;
  pullModel(progress: (p: SetupProgress) => void, signal: AbortSignal): Promise<void>;
  configure(): Promise<void>;
}
export class LocalSetup {
  value = { ...INITIAL_LOCAL_SETUP };
  private controller: AbortController | null = null;
  constructor(private dependencies: LocalSetupDependencies, private notify: (value: LocalSetupState) => void) {}
  private set(patch: Partial<LocalSetupState>) { this.value = { ...this.value, percent: undefined, completedBytes: undefined, totalBytes: undefined, error: undefined, ...patch }; this.notify(this.value); }
  async detect() {
    if (this.value.busy) return;
    this.set({ status: 'detecting', busy: true, stage: 'detect', label: '检测本机 Ollama 与 Index 模型' });
    try {
      const eligible = defaultLocalConfiguration(this.dependencies.configuration());
      if (!eligible) { this.set({ status: 'custom', busy: false, eligible: false, label: '当前使用自定义服务或模型，保留现有配置，无需准备默认环境' }); return; }
      this.set({ eligible: true });
      let probe: { hasModel: boolean } | null = null;
      try { probe = await this.dependencies.probe(AbortSignal.timeout(4000)); } catch { /* stopped service or missing installation */ }
      const hasRuntime = !!probe || !!await this.dependencies.findRuntime();
      this.set({ status: probe ? probe.hasModel ? 'ready' : 'missing-model' : hasRuntime ? 'stopped' : 'missing-runtime',
        busy: false, hasRuntime, hasModel: probe?.hasModel ?? false,
        label: probe ? probe.hasModel ? '本机 Ollama 与 Index 已就绪，现有模型已复用' : '已检测到 Ollama，尚未安装默认 Index 翻译模型' : hasRuntime ? '已安装 Ollama，服务尚未启动；点击即可启动并准备模型' : '缺少 Ollama，点击即可安装 Ollama 与 Index 翻译模型' });
    } catch { this.set({ status: 'error', busy: false, label: '本机环境检测失败', error: '请检查配置文件及本机运行环境后重新检测' }); }
  }
  async prepare() {
    if (this.value.busy) throw new Error('当前正在检测或准备本机环境，请稍候');
    if (!defaultLocalConfiguration(this.dependencies.configuration())) throw new Error('当前使用自定义服务或模型，请保留现有配置；一键安装仅用于默认本机 Ollama + Index');
    const controller = new AbortController(); this.controller = controller;
    const progress = (p: SetupProgress) => this.set({ ...p, status: 'installing', busy: true });
    this.set({ status: 'installing', busy: true, eligible: true, stage: 'detect', label: '检测并复用现有本机环境' });
    try {
      let probe: { hasModel: boolean } | null = null;
      try { probe = await this.dependencies.probe(controller.signal); } catch { controller.signal.throwIfAborted(); }
      if (!probe) {
        const executable = await this.dependencies.findRuntime() ?? await this.dependencies.installRuntime(progress, controller.signal);
        this.set({ hasRuntime: true, stage: 'service-start', label: '正在启动本机 Ollama（仅监听 127.0.0.1）' });
        await this.dependencies.startRuntime(executable, controller.signal);
        probe = await this.dependencies.probe(controller.signal);
      }
      this.set({ hasRuntime: true, hasModel: probe.hasModel });
      if (!probe.hasModel) await this.dependencies.pullModel(progress, controller.signal);
      this.set({ stage: 'model-verify', label: '验证 Index 模型是否完整可用' });
      if (!(await this.dependencies.probe(controller.signal)).hasModel) throw new Error('下载结束后未检测到 Index 模型，请重试');
      this.set({ hasModel: true, stage: 'configure', label: '自动配置本机地址与 Index 模型' });
      await this.dependencies.configure();
      this.set({ status: 'ready', busy: false, stage: 'complete', label: 'Ollama + Index 已准备并自动配置，可继续检查识别模型' });
    } catch (error) {
      this.set({ status: 'error', busy: false, label: controller.signal.aborted ? '已取消下载，可以重试继续' : '本机翻译环境准备失败，可重试',
        error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : '请检查网络与磁盘空间后重试' });
    } finally { this.controller = null; }
  }
  cancel() {
    if (this.value.busy && ['runtime-download', 'model-pull'].includes(this.value.stage)) this.controller?.abort();
  }
  dispose() { this.controller?.abort(); }
}
