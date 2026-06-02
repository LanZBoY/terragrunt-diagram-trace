// Verify how the pipeline handles a malformed terragrunt.hcl. Static analysis only.
import { parse } from '@cdktf/hcl2json';
import { build } from 'esbuild';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 1) Raw parser behavior on a syntax error (unclosed block).
const broken = `dependency "vpc" {
  config_path = "../vpc"

terraform {
  source = "../modules//app"
}
`;
console.log('=== 1) hcl2json on a syntax error ===');
try {
  const out = await parse('broken.hcl', broken);
  console.log('parsed without throwing:', JSON.stringify(out));
} catch (e) {
  console.log('THREW. message =', JSON.stringify(e.message));
}

// 2) Whole-pipeline behavior: one broken file next to one valid file.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-malformed-'));
fs.mkdirSync(path.join(tmp, 'broken'));
fs.mkdirSync(path.join(tmp, 'ok'));
fs.writeFileSync(path.join(tmp, 'broken', 'terragrunt.hcl'), broken);
fs.writeFileSync(path.join(tmp, 'ok', 'terragrunt.hcl'), 'dependency "x" {\n  config_path = "../broken"\n}\n');

const files = walkHclFiles([tmp]);
const model = await buildModel(files, [tmp], { rootConfigName: 'terragrunt.hcl' });

console.log('\n=== 2) buildModel with a broken + a valid file ===');
console.log(`units=${model.units.length} nodes=${model.nodes.length} edges=${model.edges.length}`);
for (const u of model.units) {
  console.log(`  unit ${path.relative(tmp, u.configFile)}  refs=${u.references.length}  parseError=${u.parseError ? JSON.stringify(u.parseError) : 'none'}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
