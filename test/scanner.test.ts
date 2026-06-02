import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, walkHclFiles } from '../src/core/scanner';
import type { GraphModel } from '../src/core/model';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../fixtures/sample-infra');

const unitBy = (m: GraphModel, label: string) => m.units.find((u) => u.label === label);
const endsWith = (p: string | null | undefined, suffix: string) =>
  !!p && p.split(path.sep).join('/').endsWith(suffix);

describe('walkHclFiles', () => {
  it('finds every .hcl in the sample project (7 units + 4 shared configs)', () => {
    const files = walkHclFiles([FIXTURES]);
    expect(files).toHaveLength(11);
    expect(files.some((f) => endsWith(f, 'dev/app/terragrunt.hcl'))).toBe(true);
    expect(files.some((f) => endsWith(f, 'root.hcl'))).toBe(true);
  });
});

describe('buildModel over sample-infra', () => {
  let model: GraphModel;
  beforeAll(async () => {
    const files = walkHclFiles([FIXTURES]);
    model = await buildModel(files, [FIXTURES], { rootConfigName: 'root.hcl' });
  });

  it('keeps referencing units only — incl. root.hcl (now reads region.hcl) and dev/queue', () => {
    const labels = model.units.map((u) => u.label).sort();
    expect(labels).toEqual([
      'dev/app',
      'dev/cdn',
      'dev/eks',
      'dev/logging',
      'dev/queue',
      'dev/rds',
      'dev/vpc',
      'root.hcl',
    ]);
  });

  it('produces edges of all five relationship kinds', () => {
    const types = new Set(model.edges.map((e) => e.type));
    expect(types).toEqual(new Set(['dependency', 'dependencies', 'include', 'source', 'read']));
  });

  it('indexes read_terragrunt_config as a read edge (root.hcl -> region.hcl, same-dir fallback)', () => {
    const edge = model.edges.find(
      (e) => e.type === 'read' && endsWith(e.source, 'root.hcl') && endsWith(e.target, 'region.hcl'),
    );
    expect(edge).toBeDefined();
    expect(edge!.resolved).toBe(true);
  });

  it('resolves dev/queue source from a cross-file read chain into a remote git URL with docs', () => {
    const queue = unitBy(model, 'dev/queue')!;
    const source = queue.references.find((r) => r.kind === 'source')!;
    expect(source.remote).toBe(true);
    expect(source.docUrl).toBe('https://github.com/acme/mods/tree/v2.0.0/queue');
  });

  it('resolves the local module source of dev/app to modules/app/main.tf', () => {
    const app = unitBy(model, 'dev/app')!;
    const source = app.references.find((r) => r.kind === 'source')!;
    expect(source.resolved).toBe(true);
    expect(source.remote).toBe(false);
    expect(endsWith(source.openPath, 'modules/app/main.tf')).toBe(true);
  });

  it('resolves dev/app data + run-order dependencies', () => {
    const app = unitBy(model, 'dev/app')!;
    const deps = app.references.filter((r) => r.kind === 'dependency').map((r) => r.name).sort();
    expect(deps).toEqual(['eks', 'rds']);
    const runOrder = app.references.filter((r) => r.kind === 'dependencies');
    expect(runOrder).toHaveLength(1);
    expect(endsWith(runOrder[0].openPath, 'dev/logging/terragrunt.hcl')).toBe(true);
  });

  it('classifies the concrete git:: source of dev/cdn as remote with a browsable docs URL', () => {
    const cdn = unitBy(model, 'dev/cdn')!;
    const source = cdn.references.find((r) => r.kind === 'source')!;
    expect(source.remote).toBe(true);
    expect(source.resolved).toBe(false);
    expect(source.docUrl).toBe('https://github.com/acme/terraform-modules/tree/v1.4.0/cdn');
  });

  it('reports the dynamic ${local...} source of dev/eks as unresolved with no docs URL', () => {
    const eks = unitBy(model, 'dev/eks')!;
    const source = eks.references.find((r) => r.kind === 'source')!;
    expect(source.resolved).toBe(false);
    expect(source.docUrl).toBeUndefined();
  });

  it('links dev/app -> dev/eks via a dependency edge', () => {
    const edge = model.edges.find(
      (e) =>
        e.type === 'dependency' &&
        endsWith(e.source, 'dev/app/terragrunt.hcl') &&
        endsWith(e.target, 'dev/eks/terragrunt.hcl'),
    );
    expect(edge).toBeDefined();
    expect(edge!.resolved).toBe(true);
  });

  it('exposes a navigable module node for the local source target', () => {
    const moduleNode = model.nodes.find((n) => n.kind === 'module' && endsWith(n.openPath, 'modules/app/main.tf'));
    expect(moduleNode).toBeDefined();
    expect(moduleNode!.exists).toBe(true);
  });
});
