import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const configs = [
  { entryPoints: ['src/vscode/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], outfile: 'dist/extension.js', sourcemap: true },
  { entryPoints: ['src/webview/explainMain.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2020', outfile: 'dist/explain.js', sourcemap: true, minify: true },
  { entryPoints: ['src/webview/chatMain.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2020', outfile: 'dist/chat.js', sourcemap: true, minify: true },
];
if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
