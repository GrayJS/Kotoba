// Fetch redistributable DLLs from NVIDIA, verify SHA-256, keep their licenses.
import { mkdir, stat, readdir, copyFile, readFile } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const packages = [
  ['cublas', 'https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.1.4-archive.zip', 'd534d98b0b453a98914dbf3adf47d7e84b55037abf02f87466439e1dcef581ed'],
  ['cudnn', 'https://developer.download.nvidia.com/compute/cudnn/redist/cudnn/windows-x86_64/cudnn-windows-x86_64-9.10.2.21_cuda12-archive.zip', 'c1a4567d822ebda7373fa1f19255dff4942302de741f830160b6c7d1fb31af23'],
];
await mkdir('build/downloads', { recursive: true }); await mkdir('build/gpu', { recursive: true });
async function hash(file) { const h = createHash('sha256'); for await (const c of createReadStream(file)) h.update(c); return h.digest('hex'); }
async function collect(dir, label) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name); if (e.isDirectory()) await collect(p, label);
    else if (e.name.toLowerCase().endsWith('.dll')) await copyFile(p, join('build/gpu', e.name));
    else if (/license|eula|copyright/i.test(e.name)) await copyFile(p, join('build/gpu', `${label}-${e.name}`));
  }
}
for (const [name, url, expected] of packages) {
  const archive = resolve(`build/downloads/${name}.zip`);
  if (!await stat(archive).catch(() => null) || await hash(archive) !== expected) {
    console.log(`Downloading ${name}`);
    const result = spawnSync('curl.exe', ['--fail', '--location', '--retry', '4', '--continue-at', '-', '--output', archive, url], { stdio: 'inherit' });
    if (result.status !== 0 || await hash(archive) !== expected) throw new Error(`${name}: download/hash check failed`);
  }
  const dir = resolve(`build/downloads/${name}`);
  await mkdir(dir, { recursive: true });
  const ps = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${dir.replaceAll("'", "''")}' -Force`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('GPU extraction failed');
  await collect(dir, name); console.log(`${name} ready`);
}
