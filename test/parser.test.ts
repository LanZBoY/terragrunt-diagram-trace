import { describe, it, expect, beforeEach } from 'vitest';
import { parseTerragrunt, __resetParseCache } from '../src/core/parser';

beforeEach(() => __resetParseCache());

describe('parseTerragrunt', () => {
  it('extracts a dependency config_path with its label', async () => {
    const r = await parseTerragrunt('t.hcl', 'dependency "vpc" { config_path = "../vpc" }');
    expect(r.error).toBeUndefined();
    expect(r.refs).toContainEqual({ kind: 'dependency', name: 'vpc', rawValue: '../vpc' });
  });

  it('extracts each dependencies paths[] entry as a run-order ref', async () => {
    const r = await parseTerragrunt('t.hcl', 'dependencies { paths = ["../a", "../b"] }');
    const deps = r.refs.filter((x) => x.kind === 'dependencies').map((x) => x.rawValue);
    expect(deps).toEqual(['../a', '../b']);
  });

  it('extracts a labeled include, wrapping find_in_parent_folders in ${...}', async () => {
    const r = await parseTerragrunt('t.hcl', 'include "root" { path = find_in_parent_folders("root.hcl") }');
    const inc = r.refs.find((x) => x.kind === 'include');
    expect(inc?.name).toBe('root');
    expect(inc?.rawValue).toBe('${find_in_parent_folders("root.hcl")}');
  });

  it('extracts a literal include path verbatim', async () => {
    const r = await parseTerragrunt('t.hcl', 'include "x" { path = "../shared/x.hcl" }');
    expect(r.refs).toContainEqual({ kind: 'include', name: 'x', rawValue: '../shared/x.hcl' });
  });

  it('extracts a terraform.source', async () => {
    const r = await parseTerragrunt('t.hcl', 'terraform { source = "../../modules//app" }');
    expect(r.refs).toContainEqual({ kind: 'source', rawValue: '../../modules//app' });
  });

  it('merges locals into a flat map', async () => {
    const r = await parseTerragrunt('t.hcl', 'locals {\n  env = "dev"\n  region = "ap-northeast-1"\n}');
    expect(r.localsMap.env).toBe('dev');
    expect(r.localsMap.region).toBe('ap-northeast-1');
  });

  it('surfaces a syntax error instead of throwing, and yields no refs', async () => {
    const r = await parseTerragrunt('bad.hcl', 'dependency "x" {\n  config_path = "../y"\n');
    expect(r.refs).toEqual([]);
    expect(r.error).toBeTruthy();
    expect(r.error).toMatch(/bad\.hcl:\d+,\d+/);
  });

  it('extracts a read_terragrunt_config with find_in_parent_folders, wrapped in ${...}', async () => {
    const r = await parseTerragrunt('t.hcl', 'locals {\n  x = read_terragrunt_config(find_in_parent_folders("region.hcl"))\n}');
    expect(r.refs).toContainEqual({ kind: 'read', rawValue: '${find_in_parent_folders("region.hcl")}' });
  });

  it('extracts a read_terragrunt_config with a literal path', async () => {
    const r = await parseTerragrunt('t.hcl', 'locals {\n  x = read_terragrunt_config("account.hcl")\n}');
    expect(r.refs).toContainEqual({ kind: 'read', rawValue: 'account.hcl' });
  });

  it('dedupes repeated reads of the same target', async () => {
    const r = await parseTerragrunt('t.hcl', 'locals {\n  a = read_terragrunt_config("x.hcl")\n  b = read_terragrunt_config("x.hcl")\n}');
    expect(r.refs.filter((x) => x.kind === 'read')).toHaveLength(1);
  });

  it('ignores read_terragrunt_config inside a comment', async () => {
    const r = await parseTerragrunt('t.hcl', '# read_terragrunt_config("nope.hcl")\nlocals {\n  x = "y"\n}');
    expect(r.refs.filter((x) => x.kind === 'read')).toHaveLength(0);
  });
});

describe('last-known-good cache', () => {
  it('keeps the previous refs when a syntax error appears, but still reports the error', async () => {
    const f = '/virtual/keep.hcl';
    const ok = await parseTerragrunt(f, 'dependency "vpc" { config_path = "../vpc" }');
    expect(ok.error).toBeUndefined();
    expect(ok.refs).toHaveLength(1);

    const broken = await parseTerragrunt(f, 'dependency "vpc" {\n  config_path = "../vpc"\n');
    expect(broken.error).toBeTruthy();
    expect(broken.refs).toEqual(ok.refs); // index preserved across the syntax error
  });

  it('returns empty + error when a file has never parsed successfully', async () => {
    const r = await parseTerragrunt('/virtual/never.hcl', 'dependency "x" {\n');
    expect(r.refs).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  it('refreshes the cache once the file parses cleanly again', async () => {
    const f = '/virtual/refresh.hcl';
    await parseTerragrunt(f, 'dependency "a" { config_path = "../a" }');
    await parseTerragrunt(f, 'broken {');
    const fixed = await parseTerragrunt(f, 'dependency "b" { config_path = "../b" }');
    expect(fixed.error).toBeUndefined();
    expect(fixed.refs).toEqual([{ kind: 'dependency', name: 'b', rawValue: '../b' }]);
  });
});
