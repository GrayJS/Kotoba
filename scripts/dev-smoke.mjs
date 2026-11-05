import { createServer } from 'vite';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import path from 'node:path';
const server = await createServer(); await server.listen();
const env = { ...process.env, KOTOBA_DEV_URL: 'http://127.0.0.1:5173', KOTOBA_USER_DATA: path.resolve('build/dev-profile') }; delete env.ELECTRON_RUN_AS_NODE;
let instance;
try {
  instance = await electron.launch({ executablePath: electronPath, args: ['.'], env });
  let page;
  for (let i = 0; i < 100; i++) {
    page = instance.windows().find(p => p.url().includes('view=control'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!page) throw new Error('Development control window missing');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ developmentUi: 'passed', url: page.url() }));
} finally { if (instance) await instance.close(); await server.close(); }
