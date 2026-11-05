import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
function terminateTree(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { child.kill(); });
  } else child.kill();
}
export class WorkerClient {
  child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  constructor(private executable: string, private args: string[], private env: NodeJS.ProcessEnv,
    private event: (message: Record<string, any>) => void, private crashed: (message: string) => void) {}
  async send(command: Record<string, unknown>) {
    if (!this.child) this.launch();
    await this.ready;
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('识别进程尚未就绪');
    const input = this.child.stdin;
    await new Promise<void>((resolve, reject) => input.write(JSON.stringify(command) + '\n', error => error ? reject(new Error('识别组件连接已中断')) : resolve()));
  }
  private launch() {
    const child = spawn(this.executable, this.args, { env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdin.on('error', () => { /* write callbacks/exit handler report a broken pipe */ });
    this.ready = new Promise<void>((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => { reject(new Error('识别进程启动超时')); terminateTree(child); }, 30000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (line.length > 100000) return;
        try {
          const message = JSON.parse(line);
          if (message.type === 'worker_ready') { resolved = true; clearTimeout(timeout); resolve(); }
          this.event(message);
        } catch { this.crashed('识别进程返回了无效消息'); }
      });
      child.stderr.on('data', () => { /* consume library diagnostics without persisting content */ });
      child.on('error', () => {
        clearTimeout(timeout);
        if (this.child === child) { this.child = null; this.ready = null; }
        reject(new Error('无法启动识别组件，请检查运行文件是否完整'));
      });
      child.on('exit', code => {
        clearTimeout(timeout); lines.close();
        if (this.child !== child) return;
        this.child = null; this.ready = null;
        if (!resolved) reject(new Error(`识别进程启动失败（${code}）`));
        this.crashed(`识别进程已退出（${code}），可重新检查连接`);
      });
    });
    // A spawn error may arrive before send reaches its await.
    void this.ready.catch(() => {});
  }
  dispose() {
    const child = this.child; this.child = null; this.ready = null;
    if (child) {
      if (child.stdin.writable) child.stdin.end(JSON.stringify({ action: 'quit' }) + '\n');
      const timeout = setTimeout(() => {
        // venv's python.exe is a launcher; terminate its descendants as well.
        terminateTree(child);
      }, 3500); timeout.unref();
    }
  }
}
