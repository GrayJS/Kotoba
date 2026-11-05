import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, type Languages, type ServiceSettings } from '../src/shared';
export interface Config {
  ollama: { baseUrl: string; model: string; timeoutMs: number; keepAlive: string };
  asr: { modelPath: string; device: 'cuda' | 'cpu'; gpuLibraryPath: string };
  languages: Languages;
  translation: { provider: ServiceSettings['provider']; compatible: ServiceSettings['compatible'] };
}
export const DEFAULT_CONFIG: Config = {
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'hf.co/IndexTeam/Index-Translate-2B-GGUF:Q4_K_M', timeoutMs: 15000, keepAlive: '5m' },
  asr: { modelPath: 'models/whisper-large-v3-turbo', device: 'cuda', gpuLibraryPath: '' },
  languages: { source: 'ja', target: 'zh-CN' },
  translation: { provider: 'ollama', compatible: { baseUrl: 'https://your-service.example/v1', model: '', timeoutMs: 15000 } },
};
export function parseLanguages(value: unknown): Languages {
  const v = value as Languages;
  if (!v || !Object.hasOwn(SOURCE_LANGUAGES, v.source) || !Object.hasOwn(TARGET_LANGUAGES, v.target)) throw new Error('请选择支持的源语言和目标语言');
  return { source: v.source, target: v.target };
}
export function isLocalUrl(baseUrl: string) { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname); }
function parseCompatible(value: any, required: boolean): ServiceSettings['compatible'] {
  if (!value || typeof value.baseUrl !== 'string' || typeof value.model !== 'string') throw new Error('请填写兼容 API 的地址和模型');
  const url = new URL(value.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === 'http:' && !isLocalUrl(url.href))) throw new Error('在线 API 必须使用 HTTPS；本机测试可使用 HTTP');
  const timeoutMs = value.timeoutMs ?? 15000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('timeoutMs 范围为 1000–120000');
  if (value.model.length > 200 || (required && !value.model.trim())) throw new Error('请填写在线服务模型名称');
  return { baseUrl: value.baseUrl.replace(/\/+$/, ''), model: value.model.trim(), timeoutMs };
}
export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== 'object') throw new Error('配置必须是 JSON 对象');
  const v = value as Record<string, any>;
  if (!v.ollama || !v.asr) throw new Error('配置缺少 ollama 或 asr');
  const u = new URL(v.ollama.baseUrl);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Ollama 地址必须是 HTTP/HTTPS 服务地址');
  if (typeof v.ollama.model !== 'string' || !v.ollama.model.trim() || v.ollama.model.length > 200) throw new Error('请填写 Ollama 模型名称');
  const timeout = v.ollama.timeoutMs ?? 15000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) throw new Error('timeoutMs 范围为 1000–120000');
  if (!['cuda', 'cpu'].includes(v.asr.device)) throw new Error('asr.device 必须为 cuda 或 cpu');
  if (typeof v.asr.modelPath !== 'string' || !v.asr.modelPath.trim()) throw new Error('请配置语音识别模型目录');
  if (v.asr.gpuLibraryPath !== undefined && typeof v.asr.gpuLibraryPath !== 'string') throw new Error('gpuLibraryPath 必须是目录字符串');
  if (v.ollama.keepAlive !== undefined && (typeof v.ollama.keepAlive !== 'string' || !/^(?:\d+(?:\.\d+)?[smh]|-1|0)$/.test(v.ollama.keepAlive))) throw new Error('keepAlive 示例：5m、0 或 -1');
  const provider = v.translation?.provider ?? 'ollama';
  if (!['ollama', 'compatible'].includes(provider)) throw new Error('无效的翻译服务类型');
  return {
    ollama: { baseUrl: v.ollama.baseUrl.replace(/\/+$/, ''), model: v.ollama.model.trim(), timeoutMs: timeout, keepAlive: v.ollama.keepAlive ?? '5m' },
    asr: { modelPath: v.asr.modelPath, device: v.asr.device, gpuLibraryPath: v.asr.gpuLibraryPath ?? '' },
    languages: parseLanguages(v.languages ?? DEFAULT_CONFIG.languages),
    translation: { provider, compatible: parseCompatible(v.translation?.compatible ?? DEFAULT_CONFIG.translation.compatible, provider === 'compatible') },
  };
}
export function readConfig(file: string): Config { return parseConfig(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))); }
export function saveJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(file + '.tmp', file);
}
export function modelDirectory(configFile: string, config: Config): string {
  return path.resolve(path.dirname(configFile), config.asr.modelPath);
}
