import type { UpdateState } from '../src/shared';

const PROJECT = 'https://github.com/GrayJS/Kotoba/releases/';
const API = 'https://api.github.com/repos/GrayJS/Kotoba/releases';
type Version = { text: string; core: bigint[]; pre: string[] };
function parseVersion(text: string): Version | null {
  if (typeof text !== 'string' || text.length > 150) return null;
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(text);
  if (!m) return null;
  const pre = m[4]?.split('.') ?? [];
  if (pre.some(id => /^0\d+$/.test(id))) return null;
  return { text: text.replace(/^v/, ''), core: m.slice(1, 4).map(n => BigInt(n)), pre };
}
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error('版本号格式无效');
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export function trustedProjectUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.host === 'github.com' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/GrayJS\/Kotoba\/releases\/(?:tag\/[^/]+|download\/[^/]+\/Kotoba-Setup-[0-9A-Za-z.+%-]+-x64\.exe)$/.test(url.pathname);
  } catch { return false; }
}
interface Release { version: string; prerelease: boolean; releaseUrl: string; downloadUrl?: string }
export function newestRelease(values: unknown[]): Release | undefined {
  let newest: Release | undefined;
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, any>;
    const version = parseVersion(v.tag_name);
    if (!version || v.draft !== false || typeof v.published_at !== 'string' || !Number.isFinite(Date.parse(v.published_at))) continue;
    const releaseUrl = PROJECT + 'tag/' + encodeURIComponent(v.tag_name);
    if (!trustedProjectUrl(v.html_url) || v.html_url !== releaseUrl) continue;
    const filename = `Kotoba-Setup-${version.text}-x64.exe`;
    const expectedDownload = PROJECT + 'download/' + encodeURIComponent(v.tag_name) + '/' + encodeURIComponent(filename);
    const asset = Array.isArray(v.assets) && v.assets.find((a: any) => a?.name === filename && a.state === 'uploaded' && a.size > 0 && a.browser_download_url === expectedDownload && trustedProjectUrl(a.browser_download_url));
    if (!newest || compareVersions(version.text, newest.version) > 0) newest = {
      version: version.text, prerelease: v.prerelease === true || version.pre.length > 0,
      releaseUrl, downloadUrl: asset ? asset.browser_download_url : undefined,
    };
  }
  return newest;
}

export class UpdateChecker {
  value: UpdateState;
  private pending: Promise<void> | null = null;
  constructor(currentVersion: string, private notify: (value: UpdateState) => void,
    private openExternal: (url: string) => Promise<unknown>, private request: typeof fetch = (...args) => fetch(...args)) {
    this.value = { currentVersion, status: 'idle', message: '手动检查 GitHub 更新（包含 Beta）' };
  }
  private set(patch: Omit<UpdateState, 'currentVersion'>) {
    this.value = { currentVersion: this.value.currentVersion, ...patch }; this.notify(this.value);
  }
  check(): Promise<void> {
    if (this.pending) return this.pending;
    this.set({ status: 'checking', message: '正在查询 GitHub 发布版本…' });
    this.pending = this.run().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async run() {
    try {
      const values: unknown[] = [];
      const signal = AbortSignal.timeout(10000);
      for (let page = 1; ; page++) {
        const response = await this.request(`${API}?per_page=100&page=${page}`, {
          redirect: 'error', credentials: 'omit', signal,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Kotoba/' + this.value.currentVersion },
        });
        if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 请求受限，请稍后重试' : `GitHub 查询失败（HTTP ${response.status}）`);
        let data: unknown;
        try { data = await response.json(); } catch { throw new Error('GitHub 返回的发布信息无效，请重试'); }
        if (!Array.isArray(data)) throw new Error('GitHub 返回的发布信息格式不正确，请重试');
        values.push(...data);
        if (data.length < 100) break;
        // Bound memory and requests even if a proxy returns the same full page forever.
        if (page >= 10) throw new Error('发布列表过长，请前往 GitHub 查看版本后重试');
      }
      const release = newestRelease(values);
      if (values.length && !release) throw new Error('未找到可验证的正式发布或 Beta 信息，请稍后重试');
      if (release && compareVersions(release.version, this.value.currentVersion) > 0) this.set({ status: 'available', message: `发现新版本 v${release.version}${release.prerelease ? '（测试版）' : ''}`, ...release });
      else this.set({ status: 'latest', message: release ? `当前 v${this.value.currentVersion} 已是最新版本` : 'GitHub 暂无可用发布，未发现更新' });
    } catch (error) {
      const known = error instanceof Error && /^(?:GitHub|发布列表|未找到|版本号)/.test(error.message);
      this.set({ status: 'error', message: known ? error.message : '无法连接 GitHub 或检查超时，请检查网络后重试' });
    }
  }
  async open(target: 'release' | 'download') {
    if (this.value.status !== 'available' || !['release', 'download'].includes(target)) throw new Error('请先检查更新并选择可用版本');
    const url = target === 'release' ? this.value.releaseUrl : this.value.downloadUrl;
    if (!trustedProjectUrl(url)) throw new Error('没有可信的 GitHub 更新地址，请重新检查');
    await this.openExternal(url);
  }
}
