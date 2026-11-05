import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES, type AppState, type AudioApp, type Settings, type ServiceSettings } from './shared';
import './style.css';
import './layout.css';

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    play: <path d="m8 5 11 7-11 7Z" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    sound: <><path d="m11 5-6 4H2v6h3l6 4Z" /><path d="M15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16" /></>,
    settings: <><path d="M4 7h16M4 17h16M8 4v6M16 14v6" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    check: <path d="m5 12 4 4L19 6" />,
    folder: <path d="M3 6h7l2 3h9v11H3Z" />,
    monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    pin: <><path d="m8 3 8 0-1 7 4 4H5l4-4Zm4 11v7" /></>,
    alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3v1" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.monitor}</svg>;
}
function useAppState() {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    let alive = true;
    if (!window.kotoba) return;
    const unsubscribe = window.kotoba.onState(next => { if (alive) setState(next); });
    window.kotoba.getState().then(next => { if (alive) setState(next); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (state) document.documentElement.dataset.theme = state.resolvedTheme;
  }, [state?.resolvedTheme]);
  return state;
}
const seconds = (n: number) => n ? (n / 1000).toFixed(1) + 's' : '—';

function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <button className={'toggle ' + (checked ? 'on' : '')} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}
function ServiceForm({ state, run }: { state: AppState; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [draft, setDraft] = useState<ServiceSettings>(() => structuredClone(state.service));
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const provider = draft.provider;
  const active = provider === 'ollama' ? draft.ollama : draft.compatible;
  const busy = state.setup.busy || state.download.busy;
  const patch = (value: Partial<ServiceSettings['ollama']>) => { setSaved(false); setDraft(old => ({ ...old, [provider === 'ollama' ? 'ollama' : 'compatible']: { ...active, ...value } })); };
  useEffect(() => { setDraft(structuredClone(state.service)); }, [JSON.stringify(state.service)]);
  return <details className="settings-card service-panel">
    <summary>模型服务设置 <span>{state.service.provider === 'ollama' ? 'Ollama' : '兼容 API'} · {state.service.local ? '本机服务' : '远端服务'}</span></summary>
    <form onSubmit={e => { e.preventDefault(); void run(async () => { await window.kotoba.saveService({ ...draft, apiKey: apiKey || undefined, clearKey }); setApiKey(''); setClearKey(false); setSaved(true); }); }}>
      <fieldset disabled={busy}>
        <div className="form-grid">
          <label>翻译服务<select aria-label="翻译服务" value={provider} onChange={e => { setDraft(old => ({ ...old, provider: e.target.value as ServiceSettings['provider'] })); setApiKey(''); setClearKey(false); setSaved(false); }}><option value="ollama">Ollama</option><option value="compatible">在线 / 本机兼容 API</option></select></label>
          <label>服务地址<input aria-label="服务地址" type="url" required value={active.baseUrl} onChange={e => patch({ baseUrl: e.target.value })} spellCheck={false} /></label>
          <label>模型名称<input aria-label="模型名称" required value={active.model} onChange={e => patch({ model: e.target.value })} spellCheck={false} /></label>
          <label>翻译超时（毫秒）<input aria-label="翻译超时" type="number" min="1000" max="120000" step="1000" value={active.timeoutMs} onChange={e => patch({ timeoutMs: +e.target.value })} /></label>
          {provider === 'ollama' ? <label>模型驻留时间<input aria-label="模型驻留时间" value={draft.ollama.keepAlive} onChange={e => patch({ keepAlive: e.target.value })} /></label> : <>
            <label>API 密钥（可选）<input aria-label="API 密钥" type="password" autoComplete="off" value={apiKey} placeholder={state.service.hasKey && active.baseUrl === state.service.compatible.baseUrl ? '已加密保存；留空保留' : '服务要求时填写'} onChange={e => { setApiKey(e.target.value); setClearKey(false); }} /></label>
            <label className="checkbox-label"><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); setApiKey(''); }} />清除该地址已保存的密钥</label>
          </>}
        </div>
        <p className="muted small">{provider === 'ollama' ? '默认本机地址 http://127.0.0.1:11434。请先在 Ollama 中安装 Index 翻译模型。远程地址会接收识别后的文字。' : '填写兼容 Chat Completions 的 API 前缀（通常以 /v1 结尾），程序追加 /chat/completions。远端服务会接收原文与最近两句上下文；音频仍在本机识别。密钥仅在本机加密保存。'}</p>
        <div className="form-actions"><button className="primary-small" type="submit">保存服务配置</button><button type="button" className="secondary-button" onClick={() => void run(() => window.kotoba.checkDevice())}>检查已保存的连接</button><span role="status">{saved ? '已保存，请检查连接' : state.running ? '保存会暂停当前监听' : ''}</span></div>
      </fieldset>
    </form>
  </details>;
}
function sourceLabel(state: AppState) {
  if (state.languages.source !== 'auto') return SOURCE_LANGUAGES[state.languages.source];
  const detected = state.subtitle?.sourceLanguage;
  return detected ? `自动 · ${SOURCE_LANGUAGES[detected as keyof typeof SOURCE_LANGUAGES] || detected}` : '自动检测（待确认）';
}
function App() {
  const state = useAppState();
  const [apps, setApps] = useState<AudioApp[]>([]);
  const [selected, setSelected] = useState<AudioApp | null>(null);
  const [loadingApps, setLoadingApps] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setError('');
    try { await action(); } catch (e) { setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
  }, []);
  const refresh = useCallback(async () => {
    setLoadingApps(true);
    await run(async () => {
      const list = await window.kotoba.listApps(); setApps(list);
      setSelected(old => list.find(a => a.pid === old?.pid) || null);
    });
    setLoadingApps(false);
  }, [run]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!state) return <div className="loading">正在连接桌面程序…</div>;
  const s = state.settings;
  const set = (patch: Partial<Settings>) => void run(() => window.kotoba.updateSettings(patch));
  const current = state.subtitle;
  const history = state.history || [];
  const issue = error || state.download.error || state.setup.error || state.warning;
  const local = state.service.local;
  const busy = state.setup.busy || state.download.busy;
  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark">言</span><span>Kotoba<span className="brand-dot">.</span></span><span className="brand-caption">本地双语字幕</span></div>
      <div className="header-right"><label className="theme-picker">主题<select aria-label="主题" value={s.theme} onChange={e => set({ theme: e.target.value as Settings['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><span className="privacy"><Icon name="shield" size={14} />{local ? '本机处理' : '文字发送至远端'}</span><span className={'connection-badge ' + (state.ready ? 'ready' : '')}><i />{state.ready ? '模型已就绪' : state.download.busy ? '下载中' : state.setup.busy ? '正在检查' : '等待连接'}</span></div>
    </header>
    <div className="workspace">
      <aside className="sidebar">
        <div className="section-label"><span>01 / 音频来源</span><button className="icon-button" aria-label="刷新应用列表" title="刷新应用列表" disabled={loadingApps || state.running} onClick={() => void refresh()}><Icon name="refresh" size={15} /></button></div>
        <h2>选择要听的应用</h2><p className="muted small">只采集选定应用及其子进程的声音。</p>
        <div className="app-list" role="listbox" aria-label="音频应用">
          {apps.map(item => <button role="option" aria-selected={selected?.pid === item.pid} key={item.pid} disabled={state.running} className={'audio-app ' + (selected?.pid === item.pid ? 'selected' : '')} onClick={() => setSelected(item)} title={item.name + ' · PID ' + item.pid}>
            <span className="app-avatar"><Icon name={/chrome|edge|firefox/i.test(item.name) ? 'monitor' : 'sound'} size={17} /></span><span className="app-name">{item.name.replace(/\.exe$/i, '')}<small>{item.active ? '正在播放声音' : '音频会话已就绪'}</small></span><span className={'activity-dot ' + (item.active ? 'active' : '')} />
          </button>)}
          {!apps.length && <div className="empty-apps"><Icon name="sound" size={23} /><span>{loadingApps ? '正在查找应用…' : '还没有可用的音频应用'}</span><small>先在应用中播放声音，再刷新列表</small></div>}
        </div>
        <div className="input-meter"><span>输入音量</span><div className="meter-bars">{Array.from({ length: 22 }, (_, i) => <i key={i} className={state.running && state.level * 22 > i ? 'lit' : ''} />)}</div></div>
        <button className={'start-button ' + (state.running ? 'listening' : '')} disabled={!state.running && (!selected || !state.ready)} onClick={() => void run(() => state.running ? window.kotoba.stop() : window.kotoba.start(selected!))}><Icon name={state.running ? 'pause' : 'play'} size={17} />{state.running ? '暂停监听' : '开始监听'}<kbd>Ctrl Alt S</kbd></button>
        <p className="source-note">{state.running ? state.status : '耳机或扬声器均可，无需打开麦克风。'}</p>
        <div className="sidebar-divider" />
        <div className="section-label"><span>02 / 识别模型</span><span className="mono tiny">WHISPER</span></div>
        <div className="model-block"><div className="model-icon">ASR</div><div><strong>Whisper large-v3-turbo</strong><span>本地多语言语音识别 · 同一份模型</span></div></div>
        <button className="secondary-button check-button" disabled={busy || state.running} onClick={() => void run(() => window.kotoba.downloadModel())}>{state.download.busy ? '识别模型下载中…' : state.download.prepared ? '识别模型已准备 · 检查' : state.download.error ? '重试下载识别模型' : '一键下载识别模型'}</button>
        <div className={'download-status ' + (state.download.error ? 'failure' : '')} role="status">{state.download.label}{state.download.busy && state.download.percent !== undefined && <><progress max="100" value={state.download.percent} /><small>当前文件 / 阶段 {state.download.percent}%</small></>}</div>
        <div className="device-selector" aria-label="识别计算设备"><button disabled={busy} className={s.device === 'cuda' ? 'chosen' : ''} onClick={() => set({ device: 'cuda' })}>GPU 加速</button><button disabled={busy} className={s.device === 'cpu' ? 'chosen' : ''} onClick={() => set({ device: 'cpu' })}>CPU</button></div>
        <button className="secondary-button check-button" disabled={busy} onClick={() => void run(() => window.kotoba.checkDevice())}><Icon name={state.ready ? 'check' : 'refresh'} size={15} />{state.setup.busy ? '检查中…' : '重新检查连接'}</button>
        <div className={'setup-status ' + (state.setup.error ? 'failure' : '')}><i className={state.setup.busy ? 'spinner' : 'dot'} />{state.setup.label}</div>
        <div className="config-actions"><button onClick={() => void run(() => window.kotoba.openConfig())}><Icon name="settings" size={13} />打开配置</button><button onClick={() => void run(() => window.kotoba.openModels())}><Icon name="folder" size={13} />模型目录</button></div>
        <span className="config-location" title={state.configPath}>{state.configPath}</span>
        <div className="sidebar-bottom"><span className="tiny mono">KOTOBA / v0.3.0 Beta</span><span>音频与字幕不落盘</span></div>
      </aside>
      <main className="main-content">
        <div className="page-heading"><div><div className="eyebrow">LISTEN. UNDERSTAND.</div><h1>听见声音，看懂每一句<span>。</span></h1><p>左侧选择应用开始监听，在这里设置语言和字幕。</p></div></div>
        {issue && <div className="notice" role="alert"><Icon name="alert" size={17} /><span>{issue}</span>{error && <button aria-label="关闭错误" onClick={() => setError('')}><Icon name="close" size={14} /></button>}</div>}
        <div className="language-settings settings-card"><label>源语音语言<select aria-label="源语音语言" disabled={busy} value={state.languages.source} onChange={e => void run(() => window.kotoba.saveLanguages({ ...state.languages, source: e.target.value as AppState['languages']['source'] }))}>{Object.entries(SOURCE_LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label><Icon name="arrow" /><label>译文语言<select aria-label="译文语言" disabled={busy} value={state.languages.target} onChange={e => void run(() => window.kotoba.saveLanguages({ ...state.languages, target: e.target.value as AppState['languages']['target'] }))}>{Object.entries(TARGET_LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label><span className="language-note">{state.running ? '修改语言会暂停监听' : '自动检测按句判断；手动指定可跳过判断'}<small>{sourceLabel(state)} → {TARGET_LANGUAGES[state.languages.target]}</small></span></div>
        <div className="subtitle-workspace">
        <section className="preview-section">
          <div className="panel-heading"><span><Icon name="monitor" size={16} />{current ? '实时字幕' : '字幕样式预览'}</span><span className="preview-label">{current ? 'LIVE' : 'PREVIEW'}</span></div>
          <div className="preview-stage">
            <div className="landscape"><div className="moon" /><div className="mountain back" /><div className="mountain front" /><div className="landscape-line" /><span className="landscape-caption">ことばが、つながる。</span></div>
            <div className="preview-window-label"><span className="window-dot" />{state.running ? state.selectedApp?.name : '桌面悬浮字幕'}<span><Icon name="pin" size={12} />置顶 · 直接拖动</span></div>
            <div className="subtitle-preview" style={{ backgroundColor: `rgba(8,12,11,${s.opacity})` }}>
              {(s.bilingual || current?.error) && <div className="japanese" dir="auto" lang={current?.sourceLanguage} style={{ fontSize: Math.max(14, s.fontSize * 0.65) }}>{current?.japanese || '识别后的原文将在这里显示'}</div>}
              <div className="chinese" dir="auto" lang={current?.targetLanguage} style={{ fontSize: s.fontSize }}>{current ? current.chinese || (current.error ? '暂时无法翻译，已保留原文' : '正在翻译…') : '译文将在这里显示'}</div>
            </div>
            <span className="preview-footnote">{current ? current.isFinal === false || current.translationPending ? '实时更新中 · 暂译会自动修正' : `已定稿 · 句末延迟 ${seconds(current.latencyMs)}` : '示例文字，仅用于预览字幕外观'}</span>
          </div>
          <div className="preview-toolbar"><span><i className={state.running ? 'status-dot active' : 'status-dot'} />{state.running ? state.status : '按住桌面字幕框即可拖动'}</span><div><button className={s.editMode ? 'active-text' : ''} onClick={() => set({ editMode: !s.editMode, overlayVisible: true })}><Icon name="pin" size={14} />{s.editMode ? '关闭位置预览' : '预览桌面位置'}</button><button onClick={() => set({ overlayVisible: !s.overlayVisible })}><Icon name="eye" size={15} />{s.overlayVisible ? '隐藏字幕' : '显示字幕'}</button></div></div>
        </section>
        <section className="appearance-panel">
          <div className="panel-heading"><span><Icon name="settings" size={16} />字幕外观</span><button className="text-button" onClick={() => void run(() => window.kotoba.resetPosition())}>重置位置</button></div>
          <div className="sliders"><label><span>译文字号 <b>{s.fontSize}<small>px</small></b></span><input aria-label="译文字号" type="range" min="16" max="52" value={s.fontSize} onChange={e => set({ fontSize: +e.target.value })} /></label><label><span>背景透明度 <b>{Math.round(s.opacity * 100)}<small>%</small></b></span><input aria-label="背景透明度" type="range" min="0" max="100" value={s.opacity * 100} onChange={e => set({ opacity: +e.target.value / 100 })} /></label><label><span>字幕宽度 <b>{s.width}<small>px</small></b></span><input aria-label="字幕宽度" type="range" min="400" max="1800" step="20" value={s.width} onChange={e => set({ width: +e.target.value })} /></label></div>
          <div className="bilingual-option"><div><strong>双语字幕</strong><span>同时显示原文与译文</span></div><Toggle label="双语字幕" checked={s.bilingual} onChange={checked => set({ bilingual: checked })} /></div>
          <div className="bilingual-option"><div><strong>边听边显示</strong><span>{state.running ? '暂停监听后可切换模式' : '先显示临时字幕，说完后自动定稿'}</span></div><Toggle label="边听边显示" checked={s.liveSubtitles} disabled={state.running} onChange={checked => set({ liveSubtitles: checked })} /></div>
        </section>
        </div>
        <ServiceForm state={state} run={run} />
        <section className="session-panel"><div className="panel-heading"><span>本次监听</span><div className="session-metrics"><span>原文首字 <b>{seconds(state.metrics.firstTextMs || 0)}</b></span><span>译文首字 <b>{seconds(state.metrics.firstChineseMs || 0)}</b></span><span>句末 P95 <b>{seconds(state.metrics.p95)}</b></span><span>已定稿 <b>{state.metrics.count}</b></span><span>跳过 <b>{state.metrics.dropped}</b></span></div></div>
          {!history.length ? <div className="empty-session"><span className="waveform">▂ ▅ ▃ ▇ ▄ ▂ ▅</span><span>开始监听后，最近的字幕会出现在这里。</span></div> : <div className="subtitle-history">{history.slice(0, 2).map(item => <div key={item.session + item.id}><span className="history-time">{new Date(item.endedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span><div><p className="source-text" lang={item.sourceLanguage}>{item.japanese}</p><p lang={item.targetLanguage}>{item.chinese || item.error}</p></div></div>)}</div>}
        </section>
        <footer className="main-footer"><span><Icon name="shield" size={12} />{local ? '识别与翻译均在本机运行' : '语音在本机识别，文字发送至已配置的翻译服务'}</span><span><kbd>Ctrl Alt H</kbd>显示 / 隐藏字幕</span></footer>
      </main>
    </div>
  </div>;
}

function Overlay() {
  const state = useAppState();
  useEffect(() => { document.documentElement.classList.add('overlay-document'); return () => document.documentElement.classList.remove('overlay-document'); }, []);
  useEffect(() => {
    const report = () => {
      const regions = [...document.querySelectorAll('.overlay-subtitle, .overlay-drag')].map(el => {
        const { x, y, width, height } = el.getBoundingClientRect(); return { x, y, width, height };
      });
      void window.kotoba.overlayRegions(regions).catch(() => {});
    };
    const resize = new ResizeObserver(report);
    for (const el of document.querySelectorAll('.overlay-subtitle, .overlay-drag')) resize.observe(el);
    report(); window.addEventListener('resize', report);
    return () => { resize.disconnect(); window.removeEventListener('resize', report); };
  }, [state?.subtitle, state?.settings.editMode, state?.settings.fontSize, state?.settings.width, state?.settings.bilingual]);
  if (!state) return null;
  const subtitle = state.subtitle;
  if (!subtitle && !state.settings.editMode) return null;
  const s = state.settings;
  const drag = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      event.currentTarget.setPointerCapture(event.pointerId); void window.kotoba.dragOverlay('start');
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) void window.kotoba.dragOverlay('move'); },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); void window.kotoba.dragOverlay('end'); } },
    onPointerCancel: () => { void window.kotoba.dragOverlay('end'); },
  };
  return <div className={'desktop-overlay ' + (s.editMode ? 'editing' : '')}>
    {s.editMode && <div className="overlay-drag" {...drag}><span>⠿ 拖动调整字幕位置</span><button onClick={() => window.kotoba.updateSettings({ editMode: false })}>完成</button></div>}
    <div className="overlay-subtitle" {...drag} title="按住字幕框拖动位置" style={{ backgroundColor: `rgba(8,12,11,${s.opacity})` }}>
      {subtitle && (subtitle.isFinal === false || subtitle.translationPending) && <span className="overlay-live-label">实时更新</span>}
      {(s.bilingual || subtitle?.error) && <p className="source-text" dir="auto" lang={subtitle?.sourceLanguage} style={{ fontSize: Math.max(16, s.fontSize * 0.68) }}>{subtitle?.japanese || `${sourceLabel(state)}原文将在这里显示`}</p>}
      <p dir="auto" lang={subtitle?.targetLanguage || state.languages.target} style={{ fontSize: s.fontSize }}>{subtitle ? subtitle.chinese || (subtitle.error ? '翻译暂不可用' : '正在翻译…') : `${TARGET_LANGUAGES[state.languages.target]}字幕将在这里显示`}</p>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('view') === 'overlay' ? <Overlay /> : <App />);
