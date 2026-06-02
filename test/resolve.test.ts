import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  substituteInterpolations,
  resolveFindInParentFolders,
  classifySource,
  remoteSourceUrl,
  resolveReference,
  resolveConfigPath,
  type ResolveCtx,
} from '../src/core/resolve';

function ctx(over: Partial<ResolveCtx> = {}): ResolveCtx {
  return {
    currentFile: '/ws/dev/app/terragrunt.hcl',
    currentDir: '/ws/dev/app',
    workspaceRoot: '/ws',
    rootConfigName: 'root.hcl',
    localsMap: {},
    parentDir: null,
    ...over,
  };
}

describe('substituteInterpolations', () => {
  it('resolves get_terragrunt_dir() to the current dir', () => {
    const r = substituteInterpolations('${get_terragrunt_dir()}/file', ctx());
    expect(r).toEqual({ value: '/ws/dev/app/file', dynamic: false });
  });

  it('resolves a literal ${local.x}', () => {
    const r = substituteInterpolations('${local.env}', ctx({ localsMap: { env: 'dev' } }));
    expect(r).toEqual({ value: 'dev', dynamic: false });
  });

  it('resolves a nested ${local.x} chain', () => {
    const r = substituteInterpolations('${local.a}', ctx({ localsMap: { a: '${local.b}', b: 'v' } }));
    expect(r.value).toBe('v');
    expect(r.dynamic).toBe(false);
  });

  it('marks read_terragrunt_config(...) as dynamic', () => {
    const r = substituteInterpolations('${read_terragrunt_config("x")}', ctx());
    expect(r.dynamic).toBe(true);
  });

  it('marks dependency outputs as dynamic', () => {
    const r = substituteInterpolations('${dependency.vpc.outputs.id}', ctx());
    expect(r.dynamic).toBe(true);
  });

  it('uses parentDir for path_relative_to_include()', () => {
    const r = substituteInterpolations('${path_relative_to_include()}', ctx({ parentDir: '/ws' }));
    expect(r).toEqual({ value: 'dev/app', dynamic: false });
  });

  it('is dynamic when get_parent_terragrunt_dir() has no resolved include', () => {
    const r = substituteInterpolations('${get_parent_terragrunt_dir()}', ctx({ parentDir: null }));
    expect(r.dynamic).toBe(true);
  });
});

describe('resolveFindInParentFolders', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-fipf-'));
    fs.mkdirSync(path.join(root, 'ws', 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ws', 'root.hcl'), '# root');
    fs.writeFileSync(path.join(root, 'ws', 'a', 'b', 'sibling.hcl'), '# sibling');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('walks strictly upward to the nearest match, bounded by the workspace root', () => {
    const found = resolveFindInParentFolders(
      path.join(root, 'ws', 'a', 'b'),
      'root.hcl',
      path.join(root, 'ws'),
    );
    expect(found).toBe(path.join(root, 'ws', 'root.hcl'));
  });

  it('does NOT match a file in the same dir (strictly upward)', () => {
    const found = resolveFindInParentFolders(
      path.join(root, 'ws', 'a', 'b'),
      'sibling.hcl',
      path.join(root, 'ws'),
    );
    expect(found).toBeNull();
  });

  it('returns null when nothing exists within the workspace bound', () => {
    const found = resolveFindInParentFolders(
      path.join(root, 'ws', 'a', 'b'),
      'nope.hcl',
      path.join(root, 'ws'),
    );
    expect(found).toBeNull();
  });
});

describe('classifySource', () => {
  it('treats ./ and ../ as local and applies the // subdir split', () => {
    const r = classifySource('../../modules//app', '/ws/dev/app');
    expect(r.remote).toBe(false);
    expect(r.localDir).toBe('/ws/modules/app');
  });

  it('treats git:: SCP sources as remote', () => {
    expect(classifySource('git::git@github.com:acme/mods.git//cdn?ref=v1', '/ws').remote).toBe(true);
  });

  it('treats host shorthand (github.com/...) as remote', () => {
    expect(classifySource('github.com/acme/repo', '/ws').remote).toBe(true);
  });

  it('treats a bare registry source as remote', () => {
    expect(classifySource('hashicorp/consul/aws', '/ws').remote).toBe(true);
  });
});

describe('remoteSourceUrl', () => {
  it('builds a GitHub tree URL from a git:: SCP source with ref + subdir', () => {
    expect(remoteSourceUrl('git::git@github.com:acme/terraform-modules.git//cdn?ref=v1.4.0')).toBe(
      'https://github.com/acme/terraform-modules/tree/v1.4.0/cdn',
    );
  });

  it('normalizes a plain github.com shorthand', () => {
    expect(remoteSourceUrl('github.com/acme/repo')).toBe('https://github.com/acme/repo');
  });

  it('builds a Terraform Registry URL from a versioned tfr source', () => {
    expect(
      remoteSourceUrl('tfr://registry.terraform.io/terraform-aws-modules/vpc/aws?version=5.0.0'),
    ).toBe('https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/5.0.0');
  });

  it('builds a Registry URL (latest) from a bare NAMESPACE/NAME/PROVIDER source', () => {
    expect(remoteSourceUrl('hashicorp/consul/aws')).toBe(
      'https://registry.terraform.io/modules/hashicorp/consul/aws/latest',
    );
  });

  it('returns null for a source assembled from a dynamic ${...} value', () => {
    expect(remoteSourceUrl('${local.base}//eks?ref=v3.1.0')).toBeNull();
  });
});

describe('resolveReference dispatch', () => {
  it('routes a dynamic config_path to an unresolved result', () => {
    const r = resolveConfigPath('${dependency.vpc.outputs.id}/x', ctx());
    expect(r.resolved).toBe(false);
    expect(r.reason).toBe('dynamic-function');
  });

  it('routes a remote source through resolveReference', () => {
    const r = resolveReference('source', 'git::git@github.com:acme/m.git//x?ref=v1', ctx());
    expect(r.remote).toBe(true);
    expect(r.resolved).toBe(false);
  });
});
