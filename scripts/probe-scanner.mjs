// End-to-end check of parser + resolver + scanner against fixtures/sample-infra.
// Static analysis only — does NOT run terragrunt/terraform.
import { build } from 'esbuild';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outfile = path.join(root, '.probe', 'scanner.test.cjs');

await build({
  entryPoints: [path.join(root, 'src', 'core', 'scanner.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['@cdktf/hcl2json'],
  logLevel: 'error',
});

const require = createRequire(import.meta.url);
const { buildModel, walkHclFiles } = require(outfile);

const fixture = path.join(root, 'fixtures', 'sample-infra');
const files = walkHclFiles([fixture]);
const model = await buildModel(files, [fixture], { rootConfigName: 'terragrunt.hcl' });

const rel = (p) => path.relative(fixture, p);

console.log(`Scanned ${files.length} .hcl files → ${model.units.length} units, ${model.nodes.length} nodes, ${model.edges.length} edges\n`);

for (const u of model.units) {
  console.log(`# ${u.label}${u.parseError ? '  (PARSE ERROR: ' + u.parseError + ')' : ''}`);
  for (const r of u.references) {
    const status = r.resolved ? `→ ${r.targetLabel}` : r.remote ? '→ [REMOTE]' : '→ [UNRESOLVED]';
    const open = r.openPath ? `   open=${rel(r.openPath)}${r.openIsDir ? '/' : ''}${r.exists ? '' : ' (missing)'}` : '';
    const reason = r.reason ? `   reason=${r.reason}` : '';
    console.log(`  [${r.kind}${r.name ? ' "' + r.name + '"' : ''}] ${r.rawValue}  ${status}${open}${reason}`);
  }
  console.log('');
}

console.log('NODES:');
for (const n of model.nodes) {
  const id = n.id.startsWith('external::') ? n.id : rel(n.id);
  console.log(`  (${n.kind}) ${n.label}  [${id}]${n.exists ? '' : ' MISSING'}${n.openUrl ? '  doc=' + n.openUrl : ''}`);
}

console.log('\nEDGES:');
for (const e of model.edges) {
  const tgt = e.target.startsWith('external::') ? e.target : rel(e.target);
  console.log(`  ${rel(e.source)}  --${e.type}${e.resolved ? '' : '!'}-->  ${tgt}`);
}
