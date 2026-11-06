import { createReadStream } from 'node:fs';
import { mkdir, stat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SetupProgress } from './local-setup';

export interface DownloadManifest { url: string; sha256: string; size: number }
// Published digest from the official ollama/ollama v0.40.15 release. Pinning avoids
// executing unverified downloads or relying on GitHub's anonymous API quota at install time.
export const OLLAMA_INSTALLER: DownloadManifest = {
  url: 'https://github.com/ollama/ollama/releases/download/v0.40.15/OllamaSetup.exe',
  sha256: '106ef3d2a02437810fba6f574914b1413c512ea84ddd4f184c8e7f434b6f5564', size: 1689667936,
};
async function size(file: string) { try { return (await stat(file)).size; } catch { return 0; } }
export async function downloadVerifiedFile(manifest: DownloadManifest, destination: string, progress: (p: SetupProgress) => void, signal: AbortSignal) {
  await mkdir(path.dirname(destination), { recursive: true });
  const verify = async (file: string) => {
    if (await size(file) !== manifest.size) return false;
    const hash = createHash('sha256'); let completed = 0; let last = 0;
    for await (const chunk of createReadStream(file)) {
      signal.throwIfAborted(); hash.update(chunk); completed += chunk.length;
      if (Date.now() - last > 200) { last = Date.now(); progress({ stage: 'runtime-verify', label: '校验官方 Ollama 安装包 SHA-256', completedBytes: completed, totalBytes: manifest.size, percent: Math.floor(completed / manifest.size * 100) }); }
    }
    return hash.digest('hex') === manifest.sha256;
  };
  if (await verify(destination)) return;
  const partial = destination + '.part'; let completed = await size(partial);
  if (completed > manifest.size) { await rm(partial, { force: true }); completed = 0; }
  const network = new AbortController();
  const combined = AbortSignal.any([signal, network.signal]);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => network.abort(), 60000); };
  try {
    if (completed < manifest.size) {
      progress({ stage: 'runtime-download', label: '下载官方 Ollama 0.40.15 安装包', completedBytes: completed, totalBytes: manifest.size, percent: Math.floor(completed / manifest.size * 100) });
      touch();
      const response = await fetch(manifest.url, { signal: combined, credentials: 'omit', headers: completed ? { Range: `bytes=${completed}-` } : {} });
      if (!response.ok || !response.body) throw new Error(`Ollama 安装包下载失败（HTTP ${response.status}），请重试`);
      const append = response.status === 206 && response.headers.get('content-range')?.startsWith(`bytes ${completed}-`);
      if (response.status === 206 && !append) throw new Error('下载续传范围不正确，请重试');
      if (!append) completed = 0;
      const file = await open(partial, append ? 'a' : 'w'); let last = 0;
      try {
        for await (const chunk of response.body) {
          touch(); completed += chunk.length;
          if (completed > manifest.size) throw new Error('安装包大小不符合官方记录，已停止下载');
          await file.writeFile(chunk);
          if (Date.now() - last > 150) { last = Date.now(); progress({ stage: 'runtime-download', label: '下载官方 Ollama 0.40.15 安装包', completedBytes: completed, totalBytes: manifest.size, percent: Math.floor(completed / manifest.size * 100) }); }
        }
      } finally { await file.close(); }
      if (completed !== manifest.size) throw new Error('安装包下载未完成，重试将复用已下载部分');
      progress({ stage: 'runtime-download', label: 'Ollama 安装包下载完成', percent: 100, completedBytes: completed, totalBytes: manifest.size });
    }
    clearTimeout(idle);
    if (!await verify(partial)) { await rm(partial, { force: true }); throw new Error('Ollama 安装包 SHA-256 校验失败，请重新下载'); }
    await rm(destination, { force: true }); await rename(partial, destination);
  } catch (error) {
    if (signal.aborted) throw error;
    if (network.signal.aborted) throw new Error('Ollama 下载连接超时，可重试续传');
    throw error;
  } finally { clearTimeout(idle); }
}
