import { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, safeStorage, globalShortcut, ipcMain, screen, shell, session as electronSession } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings, type AppState, type AudioApp, type ServiceUpdate, type Languages } from '../src/shared';
import { DEFAULT_CONFIG, type Config, readConfig, parseConfig, parseLanguages, saveJson, modelDirectory, isLocalUrl } from './config';
import { modelPrepared } from './model-files';
import { SecretStore } from './secrets';
import { TranslationQueue, percentile } from './pipeline';
import { checkOllama, translate } from './ollama';
import { WorkerClient } from './worker-client';
import { receiveTranscript, receiveTranslation } from './subtitles';
import { UpdateChecker } from './updates';
import { LocalSetup, INITIAL_LOCAL_SETUP, defaultLocalConfiguration, LOCAL_OLLAMA_URL, INDEX_MODEL } from './local-setup';
import { findOllama, installOllama, startOllama, probeLocalOllama, pullIndex } from './ollama-setup-runtime';

app.setName('Kotoba');
app.setAppUserModelId('local.kotoba.subtitles');
if (process.env.KOTOBA_USER_DATA) app.setPath('userData', path.resolve(process.env.KOTOBA_USER_DATA));
const execute = promisify(execFile);
const root = app.getAppPath();
const resources = app.isPackaged ? process.resourcesPath : path.join(root, 'build');
const configArgument = process.argv.find(v => v.startsWith('--config='))?.slice(9);
const configPath = path.resolve(configArgument || process.env.KOTOBA_CONFIG || (app.isPackaged ? path.join(app.getPath('userData'), 'config.json') : path.join(root, 'config.json')));
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const logFile = path.join(app.getPath('userData'), 'logs', 'status.log');
const secrets = new SecretStore(path.join(app.getPath('userData'), 'credentials.bin'), safeStorage);
let config: Config = structuredClone(DEFAULT_CONFIG);
let controller: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let tray: Tray | null = null;
let worker: WorkerClient | null = null;
let quitting = false;
let checking = false;
let configuring = false;
let downloadTarget = '';
let sampleLatencies: number[] = [];
let deviceTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pointerTimer: ReturnType<typeof setInterval> | undefined;
let overlayRegions: Electron.Rectangle[] = [];
let overlayInteractive = true;
let dragStart: { cursor: Electron.Point; bounds: Electron.Rectangle } | null = null;
const state: AppState = {
  settings: { ...DEFAULT_SETTINGS }, running: false, session: null, selectedApp: null,
  status: '配置模型后，检查连接即可开始', level: 0, subtitle: null, history: [],
  setup: { stage: 'idle', label: '等待检查本地模型', busy: false }, ready: false, gpuChecked: false,
  deviceChecked: null, warning: null, configPath, modelPath: '', ollamaUrl: '', ollamaModel: '',
  download: { busy: false, prepared: false, stage: 'idle', label: '尚未准备识别模型' },
  update: { currentVersion: app.getVersion(), status: 'idle', message: '手动检查 GitHub 更新（包含 Beta）' },
  localSetup: { ...INITIAL_LOCAL_SETUP },
  languages: { ...DEFAULT_CONFIG.languages },
  service: { ...DEFAULT_CONFIG.translation, ollama: { ...DEFAULT_CONFIG.ollama }, hasKey: false, local: true },
  resolvedTheme: 'dark',
  metrics: { count: 0, p50: 0, p95: 0, dropped: 0 },
};
const updates = new UpdateChecker(app.getVersion(), value => { state.update = value; broadcast(); }, url => shell.openExternal(url));
const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
const localSetup = new LocalSetup({
  configuration: () => readConfig(configPath), probe: probeLocalOllama,
  findRuntime: () => findOllama(localAppData),
  installRuntime: (progress, signal) => installOllama(path.join(app.getPath('userData'), 'downloads'), localAppData, progress, signal),
  startRuntime: startOllama, pullModel: pullIndex,
  configure: async () => {
    const latest = readConfig(configPath);
    if (!defaultLocalConfiguration(latest)) throw new Error('本机模型已准备，但配置已被更改；未覆盖自定义服务，请重新选择服务后检查');
    latest.ollama.baseUrl = LOCAL_OLLAMA_URL; latest.ollama.model = INDEX_MODEL;
    saveJson(configPath, latest); config = latest; updateConfigState();
  },
}, value => { state.localSetup = value; broadcast(); });
async function prepareLocalSetup() {
  ensureConfigurationIdle();
  if (state.running) throw new Error('请先暂停监听，再准备本机环境');
  state.ready = false; state.deviceChecked = null; broadcast();
  await localSetup.prepare();
  if (localSetup.value.status === 'ready') {
    if (modelPrepared(state.modelPath)) await checkConfiguration();
    else { state.setup = { busy: false, stage: 'idle', label: '翻译环境已自动配置，请点击下载 Whisper 识别模型' }; broadcast(); }
  }
}
function log(event: string, meta: Record<string, unknown> = {}) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    if (existsSync(logFile) && statSync(logFile).size > 1024 * 1024) renameSync(logFile, logFile + '.previous');
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), event, ...meta }) + '\n');
  } catch { /* diagnostics must never stop capture */ }
}
function broadcast() {
  for (const win of [controller, overlay]) if (win && !win.isDestroyed()) win.webContents.send('state:changed', state);
}
function persistSettings() { try { saveJson(settingsPath, state.settings); } catch { state.warning = '设置保存失败，请检查磁盘权限'; } }
function setStatus(text: string) { state.status = text; broadcast(); }
function markDrop() { state.metrics.dropped++; state.warning = '处理速度低于播放速度，已跳过较旧的待处理语句'; broadcast(); }
const translation = new TranslationQueue(
  (text, context, signal, detectedLanguage) => translate(config, text, context, signal, translationKey(), detectedLanguage),
  subtitle => {
    state.subtitle = receiveTranslation(state.subtitle, subtitle);
    if (state.subtitle.id === subtitle.id) state.warning = subtitle.error || null;
    state.metrics.translationMs = subtitle.translationMs;
    if (state.subtitle.id === subtitle.id) state.metrics.firstChineseMs = state.subtitle.firstChineseMs;
    if (!subtitle.error && subtitle.isFinal !== false) {
      state.metrics.count++;
      state.history = [subtitle, ...state.history.filter(item => item.id !== subtitle.id)].sort((a, b) => b.id - a.id).slice(0, 4);
      sampleLatencies = [...sampleLatencies, subtitle.latencyMs].slice(-1000);
      state.metrics.p50 = percentile(sampleLatencies, 0.5); state.metrics.p95 = percentile(sampleLatencies, 0.95);
      log('subtitle_timing', { latencyMs: subtitle.latencyMs, id: subtitle.id, firstTextMs: subtitle.firstTextMs,
        firstChineseMs: state.subtitle.id === subtitle.id ? state.subtitle.firstChineseMs : undefined,
        recognitionMs: subtitle.recognitionMs, translationMs: subtitle.translationMs, queueMs: subtitle.queueMs });
    } else if (subtitle.error) log('translation_failed');
    broadcast();
  }, markDrop,
);
async function stopCapture(message = '已暂停监听') {
  const oldSession = state.session;
  state.running = false; state.session = null; state.level = 0;
  state.subtitle = null; translation.reset(null);
  if (worker && oldSession) await worker.send({ action: 'stop' }).catch(() => {});
  setStatus(message); updateTray();
  if (oldSession) log('capture_stopped');
}
function captureExecutable() { return path.join(resources, 'native', 'loopback.exe'); }
async function listApps(): Promise<AudioApp[]> {
  if (!existsSync(captureExecutable())) throw new Error('找不到音频采集组件，请先运行 npm run build:native');
  const { stdout } = await execute(captureExecutable(), ['--list'], { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 });
  const apps = JSON.parse(stdout) as AudioApp[];
  return apps.filter(v => v.pid !== process.pid && v.pid > 0).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}
function getWorker(modelPath = state.modelPath, downloading = false) {
  if (worker) return worker;
  const executable = app.isPackaged ? path.join(resources, 'worker', 'kotoba-worker.exe') : path.join(root, '.venv', 'Scripts', 'python.exe');
  if (!existsSync(executable)) throw new Error('缺少识别运行组件，请先准备 Python 工作进程');
  const args = [...(app.isPackaged ? [] : [path.join(root, 'python', 'worker.py')]), '--model-dir', modelPath, '--capture', captureExecutable(), '--host-pid', String(process.pid)];
  const gpuPath = config.asr.gpuLibraryPath ? path.resolve(path.dirname(configPath), config.asr.gpuLibraryPath) : path.join(resources, 'gpu');
  const client = new WorkerClient(executable, args, { ...process.env, KOTOBA_GPU_PATH: gpuPath, PYTHONUTF8: '1' },
    message => { if (worker === client) { if (downloading) handleDownload(message); else handleWorker(message); } },
    message => {
      if (worker !== client) return;
      worker = null;
      if (downloading) { failDownload('下载组件退出，请重试；已下载的缓存会保留'); return; }
      state.ready = false; state.deviceChecked = null; checking = false; clearTimeout(deviceTimer);
      state.setup = { stage: 'error', label: '识别组件退出', busy: false, error: message };
      void stopCapture(message);
    });
  worker = client; return client;
}
function finishCheck() {
  checking = false; clearTimeout(deviceTimer); deviceTimer = undefined;
}
function translationKey() { return config.translation.provider === 'compatible' ? secrets.get(config.translation.compatible.baseUrl) : ''; }
function failDownload(message: string) {
  state.download = { busy: false, prepared: false, stage: 'error', label: '识别模型下载失败，可重试', error: message };
  worker?.dispose(); worker = null; broadcast(); log('model_download_failed');
}
function handleDownload(message: Record<string, any>) {
  if (!state.download.busy) return;
  if (message.type === 'progress') {
    state.download = { busy: true, prepared: false, stage: 'download', label: String(message.label),
      percent: Number.isFinite(message.percent) ? Math.max(0, Math.min(100, message.percent)) : undefined };
    broadcast();
  } else if (message.type === 'download_error' || message.type === 'error') failDownload(String(message.message));
  else if (message.type === 'download_complete') {
    try {
      if (!modelPrepared(downloadTarget)) throw new Error('下载完成但识别模型文件不完整，请重试');
      // Reload before saving so manually edited translation settings are never replaced by a stale snapshot.
      const latest = readConfig(configPath);
      if (!modelPrepared(modelDirectory(configPath, latest))) latest.asr.modelPath = downloadTarget;
      saveJson(configPath, latest); config = latest; updateConfigState();
      state.download = { busy: false, prepared: true, stage: 'complete', label: '识别模型已下载；正在检查翻译服务和推理设备' };
      worker?.dispose(); worker = null; broadcast(); log('model_download_complete');
      void checkConfiguration();
    } catch (e) { failDownload(errorText(e)); }
  }
}
async function downloadModel() {
  if (state.download.busy || checking || configuring || state.running || state.localSetup.busy) throw new Error('请先暂停监听，并等待当前下载或检查完成');
  config = readConfig(configPath); updateConfigState();
  if (modelPrepared(state.modelPath)) {
    state.download = { busy: false, prepared: true, stage: 'complete', label: '已找到现有识别模型，跳过下载' }; broadcast();
    await checkConfiguration(); return;
  }
  state.download = { busy: true, prepared: false, stage: 'download', label: '正在启动下载组件，约需 1.6 GB 空间' };
  state.ready = false; state.deviceChecked = null;
  worker?.dispose(); worker = null; broadcast();
  try {
    // Always download into a user-writable directory, never resources or Program Files.
    downloadTarget = path.join(app.getPath('userData'), 'models', 'whisper-large-v3-turbo');
    mkdirSync(downloadTarget, { recursive: true });
    await getWorker(downloadTarget, true).send({ action: 'download' });
  } catch (e) { failDownload(errorText(e)); }
}
function handleWorker(message: Record<string, any>) {
  if (message.session && message.session !== state.session) return;
  switch (message.type) {
    case 'progress': state.setup = { busy: true, stage: message.stage, label: message.label, percent: message.percent }; broadcast(); break;
    case 'ready':
      finishCheck(); state.ready = true; state.deviceChecked = message.device; state.gpuChecked = message.device === 'cuda';
      state.setup = { busy: false, stage: 'ready', label: `${message.device === 'cuda' ? 'GPU' : 'CPU'} 推理自检通过` };
      state.warning = null; setStatus('本地模型已就绪，选择应用开始监听'); log('device_check_passed', { device: message.device }); break;
    case 'device_error':
      finishCheck(); state.ready = false; state.deviceChecked = null;
      state.setup = { busy: false, stage: 'error', label: '识别模型检查失败', error: String(message.message) };
      setStatus('请检查识别模型路径及 GPU 依赖，或切换 CPU'); log('device_check_failed'); break;
    case 'capture_ready': if (state.running) setStatus(`正在监听 ${state.selectedApp?.name || ''}`); break;
    case 'level': state.level = Number(message.value) || 0; broadcast(); break;
    case 'transcript':
      if (state.running && typeof message.japanese === 'string' && message.japanese.length < 10000 && Number.isFinite(message.endedAt) && Number.isSafeInteger(message.id)) {
        const first = !state.subtitle || state.subtitle.id !== message.id;
        message.targetLanguage = config.languages.target;
        state.subtitle = receiveTranscript(state.subtitle, message as any);
        state.metrics.firstTextMs = message.firstTextMs;
        state.metrics.recognitionMs = message.recognitionMs;
        state.metrics.queueMs = message.queueMs;
        if (first) log('first_text_timing', { id: message.id, firstTextMs: message.firstTextMs, recognitionMs: message.recognitionMs, queueMs: message.queueMs });
        broadcast();
        translation.add(message as any);
      }
      break;
    case 'dropped': markDrop(); break;
    case 'target_exited': void stopCapture('目标应用已退出，请重新选择应用'); break;
    case 'capture_ended': if (state.running) void stopCapture('音频采集已结束，请重新选择应用'); break;
    case 'capture_error': case 'recognition_error':
      if (message.type === 'recognition_error') { state.ready = false; state.deviceChecked = null; }
      state.warning = String(message.message); log(message.type); void stopCapture('监听已停止，请检查错误后重试'); break;
    case 'error':
      finishCheck(); state.warning = String(message.message); state.setup.busy = false;
      if (state.running) void stopCapture('识别进程报告错误'); else broadcast(); break;
  }
}
async function checkConfiguration() {
  if (state.download.busy || checking || configuring || state.localSetup.busy) throw new Error('请等待当前下载或检查完成');
  checking = true;
  state.ready = false; state.deviceChecked = null; state.gpuChecked = false; state.warning = null;
  await stopCapture('正在检查配置与本地服务');
  worker?.dispose(); worker = null;
  state.setup = { busy: true, stage: 'connection', label: '检查翻译服务连接与模型' }; broadcast();
  try {
    config = readConfig(configPath); updateConfigState();
    state.settings.device = config.asr.device; persistSettings();
    if (config.translation.provider === 'ollama') await checkOllama(config);
    state.setup = { busy: true, stage: 'warmup', label: '预热翻译模型（首次加载可能较慢）' }; broadcast();
    await translate({ ...config, ollama: { ...config.ollama, timeoutMs: 120000 }, translation: { ...config.translation, compatible: { ...config.translation.compatible, timeoutMs: 120000 } } }, 'Hello.', [], new AbortController().signal, translationKey());
    state.setup = { busy: true, stage: 'check', label: '加载识别模型并检查计算设备' }; broadcast();
    deviceTimer = setTimeout(() => {
      finishCheck(); worker?.dispose(); worker = null;
      state.setup = { busy: false, stage: 'error', label: '识别自检超时', error: '超过 120 秒未完成自检，请检查模型与依赖后重试' }; broadcast();
    }, 120000);
    await getWorker().send({ action: 'check', device: config.asr.device });
  } catch (e) {
    finishCheck(); state.setup = { busy: false, stage: 'error', label: '配置检查失败', error: errorText(e) };
    setStatus('在模型服务设置中修改后，重新检查连接；识别模型下载状态独立保留'); log('configuration_check_failed');
  }
}
function errorText(e: unknown) { return e instanceof Error ? e.message : String(e); }
function updateConfigState() {
  state.modelPath = modelDirectory(configPath, config);
  state.ollamaUrl = config.ollama.baseUrl; state.ollamaModel = config.ollama.model;
  state.languages = { ...config.languages };
  const service = config.translation.provider === 'ollama' ? config.ollama : config.translation.compatible;
  let hasKey = false;
  try { hasKey = !!secrets.get(config.translation.compatible.baseUrl); } catch (e) { state.warning = errorText(e); }
  state.service = { provider: config.translation.provider, ollama: { ...config.ollama }, compatible: { ...config.translation.compatible }, hasKey, local: isLocalUrl(service.baseUrl) };
  if (!state.download.busy) {
    const prepared = modelPrepared(state.modelPath);
    state.download = { busy: false, prepared, stage: prepared ? 'complete' : 'idle', label: prepared ? '识别模型文件已准备，检查连接后可使用' : '点击下载识别模型，无需填写路径' };
  }
}
function ensureConfigurationIdle() {
  if (checking || state.download.busy || configuring || state.localSetup.busy) throw new Error('请等待当前下载或检查完成后再保存设置');
}
async function saveLanguages(value: Languages) {
  ensureConfigurationIdle();
  const languages = parseLanguages(value);
  configuring = true;
  try {
  await stopCapture('语言设置已保存，重新开始监听即可生效');
  const latest = readConfig(configPath); latest.languages = languages;
  saveJson(configPath, latest); config = latest; state.history = []; updateConfigState(); broadcast();
  } finally { configuring = false; }
}
async function saveService(value: ServiceUpdate) {
  ensureConfigurationIdle();
  if (!value || typeof value !== 'object' || (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 8192 || /[\r\n]/.test(value.apiKey)))) throw new Error('无效服务配置或密钥');
  const latest = readConfig(configPath);
  const next = parseConfig({ ...latest, ollama: value.ollama, translation: { provider: value.provider, compatible: value.compatible } });
  configuring = true;
  try {
  await stopCapture('服务配置已保存，请重新检查连接');
  if (value.clearKey || value.apiKey) secrets.set(next.translation.compatible.baseUrl, value.clearKey ? '' : value.apiKey!.trim());
  saveJson(configPath, next); config = next; updateConfigState();
  state.ready = false; state.deviceChecked = null;
  state.setup = { busy: false, stage: 'idle', label: '服务配置已保存，请重新检查连接' }; broadcast();
  void localSetup.detect();
  } finally { configuring = false; }
}
async function startCapture(candidate: unknown) {
  if (!state.ready || state.setup.busy || state.download.busy || configuring || state.localSetup.busy) throw new Error('请先检查连接并完成识别模型自检');
  if (!candidate || typeof candidate !== 'object' || !Number.isSafeInteger((candidate as AudioApp).pid)) throw new Error('请选择有效的应用');
  const selected = (await listApps()).find(v => v.pid === (candidate as AudioApp).pid);
  if (!selected) throw new Error('应用已退出或尚未创建音频会话，请播放声音后刷新');
  if (!state.ready || state.setup.busy || state.download.busy || configuring || state.localSetup.busy) throw new Error('配置正在变化，请稍后重新开始监听');
  await stopCapture();
  state.session = randomUUID(); state.running = true; state.selectedApp = selected; state.warning = null;
  state.subtitle = null; state.history = []; state.metrics = { count: 0, p50: 0, p95: 0, dropped: 0 }; sampleLatencies = [];
  translation.reset(state.session);
  try { await getWorker().send({ action: 'start', session: state.session, pid: selected.pid, device: state.settings.device, streaming: state.settings.liveSubtitles, language: config.languages.source }); }
  catch (e) { await stopCapture(); throw e; }
  setStatus('正在启动应用音频采集'); updateTray(); log('capture_started');
}
function overlayBounds(reset = false): Electron.Rectangle {
  const saved = !reset && state.settings.bounds;
  const area = saved ? screen.getDisplayMatching({ ...saved, width: state.settings.width, height: 180 }).workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(state.settings.width, area.width - 32);
  const height = Math.max(180, Math.round(state.settings.fontSize * 5.5));
  if (saved) {
    return { x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)), width, height };
  }
  return { x: Math.round(area.x + (area.width - width) / 2), y: area.y + area.height - height - 44, width, height };
}
function applyOverlay(reset = false) {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(overlayBounds(reset));
  overlay.setIgnoreMouseEvents(false);
  overlayInteractive = true;
  overlay.setFocusable(false);
  if (state.settings.overlayVisible) overlay.showInactive(); else overlay.hide();
}
function updateSettings(patch: Partial<Settings>) {
  if (!patch || typeof patch !== 'object') throw new Error('无效设置');
  if (patch.liveSubtitles !== undefined && patch.liveSubtitles !== state.settings.liveSubtitles && state.running) throw new Error('请先暂停监听，再切换字幕模式');
  const next = { ...state.settings };
  for (const [key, min, max] of [['fontSize', 16, 52], ['opacity', 0, 1], ['width', 400, 2000]] as const) {
    const value = patch[key]; if (value !== undefined) {
      if (!Number.isFinite(value)) throw new Error('字幕设置必须是有效数值');
      next[key] = key === 'opacity' ? Math.min(max, Math.max(min, value)) : Math.round(Math.min(max, Math.max(min, value)));
    }
  }
  for (const key of ['bilingual', 'overlayVisible', 'editMode', 'liveSubtitles'] as const) if (typeof patch[key] === 'boolean') next[key] = patch[key];
  if (patch.device !== undefined && patch.device !== next.device) {
    if (!['cuda', 'cpu'].includes(patch.device)) throw new Error('无效设备');
    ensureConfigurationIdle();
    const latest = readConfig(configPath); latest.asr.device = patch.device; saveJson(configPath, latest); config = latest;
    next.device = patch.device; updateConfigState();
    state.ready = false; state.deviceChecked = null; state.gpuChecked = false;
    state.setup = { busy: false, stage: 'idle', label: '计算设备已切换，请重新检查连接' };
    void stopCapture('计算设备已切换，请重新检查连接');
    worker?.dispose(); worker = null;
  }
  if (patch.theme !== undefined) {
    if (!['system', 'light', 'dark'].includes(patch.theme)) throw new Error('无效主题');
    next.theme = patch.theme;
  }
  state.settings = next; applyTheme(); persistSettings(); applyOverlay(); updateTray(); broadcast();
}
function applyTheme() {
  nativeTheme.themeSource = state.settings.theme;
  state.resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  controller?.setBackgroundColor(state.resolvedTheme === 'dark' ? '#101211' : '#f3f5f0');
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制台', click: showController },
    { label: state.running ? '暂停监听' : '开始监听', enabled: state.running || !!state.selectedApp && state.ready, click: () => { if (state.running) void stopCapture(); else if (state.selectedApp) void startCapture(state.selectedApp).catch(e => { state.warning = errorText(e); broadcast(); }); } },
    { type: 'separator' },
    { label: '显示桌面字幕', type: 'checkbox', checked: state.settings.overlayVisible, click: item => updateSettings({ overlayVisible: item.checked }) },
    { label: '编辑字幕位置', type: 'checkbox', checked: state.settings.editMode, click: item => updateSettings({ editMode: item.checked, overlayVisible: true }) },
    { label: '重置字幕位置', click: () => { state.settings.bounds = undefined; applyOverlay(true); persistSettings(); } },
    { type: 'separator' }, { label: '退出 Kotoba', click: () => app.quit() },
  ]));
  tray.setToolTip(state.running ? 'Kotoba · 正在监听' : 'Kotoba · 实时双语字幕');
}
function showController() { controller?.show(); controller?.focus(); }
function hardenWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
}
function loadWindow(win: BrowserWindow, role: string) {
  const devUrl = process.env.KOTOBA_DEV_URL;
  if (!app.isPackaged && devUrl === 'http://127.0.0.1:5173') void win.loadURL(devUrl + '/?view=' + role);
  else void win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { view: role } });
}
function registerIpc() {
  const handle = (name: string, callback: (...args: any[]) => unknown) => ipcMain.handle(name, (event, ...args) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || ![controller?.webContents.id, overlay?.webContents.id].includes(event.sender.id)) throw new Error('IPC access denied');
    return callback(...args);
  });
  handle('state:get', () => state); handle('apps:list', listApps);
  handle('capture:start', startCapture); handle('capture:stop', () => stopCapture());
  handle('config:check', checkConfiguration);
  handle('models:download', downloadModel);
  // Configuration writes are available only to the trusted controller, not the overlay.
  const controlOnly = (callback: (value: any) => unknown) => (event: Electron.IpcMainInvokeEvent, value: unknown) => {
    if (event.sender.id !== controller?.webContents.id || event.senderFrame !== event.sender.mainFrame) throw new Error('IPC access denied');
    return callback(value);
  };
  ipcMain.handle('config:languages', controlOnly(saveLanguages));
  ipcMain.handle('config:service', controlOnly(saveService));
  ipcMain.handle('updates:check', controlOnly(() => updates.check()));
  ipcMain.handle('updates:open', controlOnly(target => updates.open(target)));
  ipcMain.handle('local-setup:detect', controlOnly(() => { ensureConfigurationIdle(); return localSetup.detect(); }));
  ipcMain.handle('local-setup:prepare', controlOnly(prepareLocalSetup));
  ipcMain.handle('local-setup:cancel', controlOnly(() => localSetup.cancel()));
  ipcMain.handle('overlay:regions', (event, regions) => {
    if (event.sender.id !== overlay?.webContents.id || event.senderFrame !== event.sender.mainFrame) throw new Error('IPC access denied');
    if (!Array.isArray(regions) || regions.length > 2 || regions.some(r => !r || ['x', 'y', 'width', 'height'].some(k => !Number.isFinite(r[k]) || Math.abs(r[k]) > 10000))) throw new Error('Invalid overlay regions');
    overlayRegions = regions.map(({ x, y, width, height }) => ({ x, y, width, height }));
  });
  ipcMain.handle('overlay:drag', (event, phase) => {
    if (event.sender.id !== overlay?.webContents.id || event.senderFrame !== event.sender.mainFrame || !['start', 'move', 'end'].includes(phase)) throw new Error('IPC access denied');
    if (phase === 'start') dragStart = { cursor: screen.getCursorScreenPoint(), bounds: overlay.getBounds() };
    else if (dragStart) {
      const point = screen.getCursorScreenPoint();
      overlay.setPosition(Math.round(dragStart.bounds.x + point.x - dragStart.cursor.x), Math.round(dragStart.bounds.y + point.y - dragStart.cursor.y));
      if (phase === 'end') { dragStart = null; applyOverlay(); persistSettings(); broadcast(); }
    }
  });
  handle('config:open', async () => { const error = await shell.openPath(configPath); if (error) throw new Error(error); });
  handle('models:open', async () => { mkdirSync(state.modelPath, { recursive: true }); const error = await shell.openPath(state.modelPath); if (error) throw new Error(error); });
  handle('settings:update', updateSettings);
  handle('overlay:reset', () => { state.settings.bounds = undefined; applyOverlay(true); persistSettings(); broadcast(); });
}
async function initialize() {
  if (!existsSync(configPath)) saveJson(configPath, DEFAULT_CONFIG);
  try { config = readConfig(configPath); } catch (e) { state.warning = errorText(e); }
  try {
    // Read visual preferences separately; device always comes from the editable config.
    const saved = JSON.parse(require('node:fs').readFileSync(settingsPath, 'utf8'));
    if (saved && typeof saved === 'object') {
      for (const key of ['fontSize', 'opacity', 'width'] as const) if (typeof saved[key] === 'number' && Number.isFinite(saved[key])) state.settings[key] = Math.max(key === 'fontSize' ? 16 : key === 'width' ? 400 : 0, Math.min(key === 'fontSize' ? 52 : key === 'width' ? 2000 : 1, saved[key]));
      if (typeof saved.bilingual === 'boolean') state.settings.bilingual = saved.bilingual;
      if (typeof saved.overlayVisible === 'boolean') state.settings.overlayVisible = saved.overlayVisible;
      if (typeof saved.liveSubtitles === 'boolean') state.settings.liveSubtitles = saved.liveSubtitles;
      if (['system', 'light', 'dark'].includes(saved.theme)) state.settings.theme = saved.theme;
      if (saved.bounds && Number.isFinite(saved.bounds.x) && Number.isFinite(saved.bounds.y)) state.settings.bounds = { x: Math.round(saved.bounds.x), y: Math.round(saved.bounds.y) };
    }
  } catch { /* first start */ }
  state.settings.device = config.asr.device; updateConfigState();
  applyTheme();
  nativeTheme.on('updated', () => { state.resolvedTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; controller?.setBackgroundColor(state.resolvedTheme === 'dark' ? '#101211' : '#f3f5f0'); broadcast(); });
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  controller = new BrowserWindow({ width: 1160, height: 820, minWidth: 960, minHeight: 720, backgroundColor: '#101111', title: 'Kotoba · 本地双语字幕', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  overlay = new BrowserWindow({ ...overlayBounds(), frame: false, transparent: true, hasShadow: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  for (const win of [controller, overlay]) hardenWindow(win);
  registerIpc(); loadWindow(controller, 'control'); loadWindow(overlay, 'overlay'); applyOverlay();
  // Native draggable regions consume mouse events. Hit-test against cursor position instead
  // of relying on renderer mousemove events, which are unreliable during click-through.
  pointerTimer = setInterval(() => {
    if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
    const point = screen.getCursorScreenPoint(); const bounds = overlay.getBounds();
    const interactive = !!dragStart || overlayRegions.some(r => point.x >= bounds.x + r.x && point.x <= bounds.x + r.x + r.width && point.y >= bounds.y + r.y && point.y <= bounds.y + r.y + r.height);
    if (interactive !== overlayInteractive) { overlayInteractive = interactive; overlay.setIgnoreMouseEvents(!interactive, { forward: true }); }
  }, 50);
  controller.on('close', event => { if (!quitting) { event.preventDefault(); controller?.hide(); } });
  overlay.on('move', () => {
    if (!overlay) return;
    const { x, y } = overlay.getBounds(); state.settings.bounds = { x, y }; clearTimeout(saveTimer); saveTimer = setTimeout(persistSettings, 200);
  });
  screen.on('display-removed', () => applyOverlay());
  screen.on('display-metrics-changed', () => applyOverlay());
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="1" y="1" width="30" height="30" rx="9" fill="#ccf280"/><path d="M8 10h16M16 7v18M9 23l14-12" stroke="#172414" stroke-width="3" stroke-linecap="round"/></svg>';
  // NativeImage SVG support varies on Windows; a PNG is generated at build time.
  const iconPath = path.join(__dirname, 'renderer', 'tray.png');
  let icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
  if (icon.isEmpty()) { const pixels = Buffer.alloc(32 * 32 * 4); for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 128; pixels[i + 1] = 242; pixels[i + 2] = 204; pixels[i + 3] = 255; } icon = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }); }
  tray = new Tray(icon); tray.on('double-click', showController); updateTray();
  const pauseRegistered = globalShortcut.register('CommandOrControl+Alt+S', () => { if (state.running) void stopCapture(); else if (state.selectedApp && state.ready) void startCapture(state.selectedApp).catch(e => { state.warning = errorText(e); broadcast(); }); });
  const hideRegistered = globalShortcut.register('CommandOrControl+Alt+H', () => updateSettings({ overlayVisible: !state.settings.overlayVisible }));
  if (!pauseRegistered || !hideRegistered) state.warning = '部分快捷键已被占用，可通过托盘操作';
  broadcast(); log('application_started'); void localSetup.detect();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showController);
  app.whenReady().then(initialize).catch(e => { log('startup_failed'); console.error(errorText(e)); app.quit(); });
  app.on('activate', showController);
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => { quitting = true; localSetup.dispose(); translation.reset(null); worker?.dispose(); worker = null; clearTimeout(deviceTimer); clearTimeout(saveTimer); clearInterval(pointerTimer); persistSettings(); globalShortcut.unregisterAll(); tray?.destroy(); });
}
