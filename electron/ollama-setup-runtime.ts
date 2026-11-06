import { existsSync, statSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import net from 'node:net';
import { INDEX_MODEL, LOCAL_OLLAMA_URL, type SetupProgress } from './local-setup';
import { downloadVerifiedFile, OLLAMA_INSTALLER } from './setup-download';

const execute = promisify(execFile);
export async function probeLocalOllama(signal: AbortSignal) {
  const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]), redirect: 'error' as const, credentials: 'omit' as const };
  const version = await fetch(LOCAL_OLLAMA_URL + '/api/version', options);
  if (!version.ok || typeof (await version.json() as any).version !== 'string') throw new Error('本机地址未返回有效 Ollama 服务');
  const response = await fetch(LOCAL_OLLAMA_URL + '/api/tags', options);
  if (!response.ok) throw new Error('无法读取本机 Ollama 模型列表');
  const data = await response.json() as any;
  if (!Array.isArray(data.models)) throw new Error('本机 Ollama 模型列表格式无效');
  return { hasModel: data.models.some((model: any) => model?.name === INDEX_MODEL || model?.model === INDEX_MODEL) };
}
export async function findOllama(localAppData: string): Promise<string | null> {
  const executableFile = (file: string) => { try { const s = statSync(file); return s.isFile() && s.size > 0; } catch { return false; } };
  const directories = [path.join(localAppData, 'Programs', 'Ollama'), ...(process.env.PATH || '').split(path.delimiter).map(p => p.replace(/^"|"$/g, ''))];
  for (const directory of directories) { const file = path.join(directory, 'ollama.exe'); if (path.isAbsolute(directory) && executableFile(file)) return file; }
  try {
    const { stdout } = await execute(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', "$p = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{44E83376-CE68-45EB-8FC1-393500EB558C}_is1' -ErrorAction SilentlyContinue).InstallLocation; if ($p) { Write-Output $p }"],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const directory = stdout.trim(); const file = path.join(directory, 'ollama.exe');
    if (path.isAbsolute(directory) && executableFile(file)) return file;
  } catch { /* not registered; fall back to official installer */ }
  return null;
}
async function portOccupied(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 11434 });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(1000, () => finish(false));
  });
}
export async function installOllama(cache: string, localAppData: string, progress: (p: SetupProgress) => void, signal: AbortSignal) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('一键安装目前仅支持 Windows x64');
  if (await portOccupied()) throw new Error('11434 端口已有服务，但未能验证为可用 Ollama；请先检查本机服务');
  const file = path.join(cache, 'OllamaSetup-0.40.15.exe');
  await downloadVerifiedFile(OLLAMA_INSTALLER, file, progress, signal);
  signal.throwIfAborted();
  // Another app or the user may have installed Ollama during the large download.
  const existing = await findOllama(localAppData); if (existing) return existing;
  if (await portOccupied()) throw new Error('本机 Ollama 服务在下载期间发生变化，请重新检测后继续；已保留安装包缓存');
  progress({ stage: 'runtime-install', label: '正在安装官方 Ollama 到当前用户目录，请稍候' });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/DIR=' + path.join(localAppData, 'Programs', 'Ollama')],
      { windowsHide: true, stdio: 'ignore', env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' } });
    // Do not terminate an installer in the middle of writing runtime files.
    const timeout = setTimeout(() => reject(new Error('Ollama 安装超过 15 分钟，请等待系统安装完成后重新检测')), 15 * 60 * 1000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('无法运行已校验的 Ollama 安装程序，请检查系统权限')); });
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`Ollama 安装程序未成功完成（退出码 ${code}），请重试`)); });
  });
  const executable = await findOllama(localAppData);
  if (!executable) throw new Error('安装结束后未找到 Ollama，请重新检测或重试');
  return executable;
}
export async function startOllama(executable: string, signal: AbortSignal) {
  try { await probeLocalOllama(signal); return; } catch { signal.throwIfAborted(); }
  const occupied = await portOccupied(); let launchFailed = false;
  if (!occupied) {
    const gui = path.join(path.dirname(executable), 'ollama app.exe');
    const child = spawn(existsSync(gui) ? gui : executable, existsSync(gui) ? [] : ['serve'],
      { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11434' } });
    child.on('error', () => { launchFailed = true; }); child.unref();
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (launchFailed) throw new Error('无法启动已有 Ollama，请检查运行组件');
    try { await probeLocalOllama(signal); return; } catch { signal.throwIfAborted(); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(occupied ? '11434 端口被占用或 Ollama 尚未就绪，请检查服务后重试' : 'Ollama 服务启动超时，请重新检测；程序不会替换已有模型');
}

export async function pullIndex(progress: (p: SetupProgress) => void, signal: AbortSignal, request: typeof fetch = (...args) => fetch(...args)) {
  const idleController = new AbortController(); let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => idleController.abort(), 120000); };
  const combined = AbortSignal.any([signal, idleController.signal]);
  let success = false;
  const line = (text: string) => {
    if (!text.trim()) return;
    let message: any;
    try { message = JSON.parse(text); } catch { throw new Error('Ollama 下载返回了无效进度，请重试'); }
    if (message.error) throw new Error('Index 模型下载失败，请检查网络、磁盘空间及 Ollama 后重试');
    if (message.status === 'success') success = true;
    const total = Number(message.total), completed = Number(message.completed);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(completed) && completed >= 0 && completed <= total) {
      progress({ stage: 'model-pull', label: '下载 Index 模型 · 当前文件', totalBytes: total, completedBytes: completed, percent: Math.floor(completed / total * 100) });
    } else progress({ stage: 'model-pull', label: message.status === 'success' ? 'Index 模型文件已准备' : /verif|writ/i.test(String(message.status)) ? 'Ollama 正在校验并保存 Index 模型' : '正在连接模型源并准备 Index 下载' });
  };
  try {
    progress({ stage: 'model-pull', label: '连接模型源，开始安装 Index 翻译模型' }); touch();
    const response = await request(LOCAL_OLLAMA_URL + '/api/pull', {
      method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: INDEX_MODEL, stream: true }), signal: combined,
    });
    if (!response.ok || !response.body) throw new Error(`Index 下载请求失败（HTTP ${response.status}），请重试`);
    const decoder = new TextDecoder(); let pending = '';
    for await (const chunk of response.body) {
      touch(); pending += decoder.decode(chunk, { stream: true });
      if (pending.length > 1024 * 1024) throw new Error('Ollama 下载进度消息过大，已停止读取');
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) { line(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
    }
    line(pending + decoder.decode());
    if (!success) throw new Error('Index 下载连接提前结束，可重试继续下载');
  } catch (error) {
    if (signal.aborted) throw error;
    if (idleController.signal.aborted) throw new Error('Index 下载长时间没有响应，可重试续传');
    if (error instanceof TypeError) throw new Error('无法连接本机 Ollama 下载接口，请重新检测后重试');
    throw error;
  } finally { clearTimeout(idle); }
}
