// esbuild build driver. Run: node esbuild.js [--production] [--watch]
//
// Two independent bundles:
//   (1) Extension host  src/extension.ts -> dist/extension.js   (node / cjs)
//   (2) Webview graph   media/graph.ts   -> media/graph.js       (browser / iife)
//
// @cdktf/hcl2json is EXTERNAL on purpose: it loads main.wasm.gz via __dirname and
// dynamically require()s ../wasm/bridge_wasm_exec.js, so esbuild cannot bundle it.
// It stays in `dependencies` and ships unbundled in node_modules inside the VSIX.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Logs esbuild problems with file/line so CI surfaces them. */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✖ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}`);
        }
      });
      const label = build.initialOptions.outfile;
      console.log(`[build] ${label} — ${result.errors.length} errors, ${result.warnings.length} warnings`);
    });
  },
};

/** (1) Extension host bundle. */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', '@cdktf/hcl2json'],
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

/** (2) Webview bundle. Browser sandbox; cytoscape + cytoscape-dagre + dagre bundled in. */
const webviewConfig = {
  entryPoints: ['media/graph.ts'],
  outfile: 'media/graph.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

async function main() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxWeb = await esbuild.context(webviewConfig);
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log('[watch] watching extension + webview bundles…');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
