import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['client/app.js'], bundle: true, minify: true, format: 'esm', outfile: 'dist/app.js', target: ['es2022'], sourcemap: false });
await cp('client/index.html', 'dist/index.html');
await cp('client/app.css', 'dist/app.css');
