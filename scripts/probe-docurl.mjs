// Validate remoteSourceUrl() against common terraform source formats. Static only.
import { build } from 'esbuild';
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outfile = path.join(root, '.probe', 'resolve.test.cjs');

await build({
  entryPoints: [path.join(root, 'src', 'core', 'resolve.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'error',
});
const require = createRequire(import.meta.url);
const { remoteSourceUrl } = require(outfile);

const cases = [
  'git::git@github.com:acme/terraform-modules.git//eks?ref=v3.1.0',
  'git::https://github.com/acme/repo.git//modules/vpc?ref=v2.0.0',
  'github.com/org/repo//mod',
  'git@github.com:org/repo.git',
  'tfr://registry.terraform.io/terraform-aws-modules/vpc/aws?version=5.1.0',
  'terraform-aws-modules/vpc/aws',
  'terraform-aws-modules/vpc/aws//modules/subnets',
  'git::https://gitlab.com/group/proj.git//infra?ref=main',
  'bitbucket.org/team/repo//mod',
  'https://example.com/modules/foo.zip',
  '../../modules//vpc',
  '${local.base}//eks?ref=v1',
];

for (const c of cases) {
  console.log(`${c}\n   → ${remoteSourceUrl(c) ?? '(null)'}\n`);
}
