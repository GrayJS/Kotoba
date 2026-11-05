import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await viteBuild();
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
