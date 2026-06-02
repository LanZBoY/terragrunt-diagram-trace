import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  introspectModule,
  clearModuleCache,
  dependencyModuleDir,
  unitModuleDir,
} from '../src/core/moduleIntrospect';
import { buildModel, walkHclFiles } from '../src/core/scanner';
import type { GraphModel } from '../src/core/model';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../fixtures/sample-infra');
const endsWith = (p: string | null, suffix: string) =>
  !!p && p.split(path.sep).join('/').endsWith(suffix);

describe('introspectModule', () => {
  afterEach(() => clearModuleCache());

  it("reads a module's declared outputs and variables from its .tf files", async () => {
    const r = await introspectModule(path.join(FIXTURES, 'modules/vpc'));
    expect(r.outputs).toEqual(['subnet_ids', 'vpc_id']); // sorted
    expect(r.variables).toEqual(['cidr_block']);
  });

  it('returns empty for a non-existent module directory', async () => {
    const r = await introspectModule(path.join(FIXTURES, 'modules/nope'));
    expect(r).toEqual({ outputs: [], variables: [] });
  });
});

describe('dependency / unit module resolution', () => {
  let model: GraphModel;
  beforeAll(async () => {
    model = await buildModel(walkHclFiles([FIXTURES]), [FIXTURES], { rootConfigName: 'root.hcl' });
  });

  it('unitModuleDir resolves a unit to its own source module', () => {
    const vpc = model.units.find((u) => u.label === 'dev/vpc')!;
    expect(endsWith(unitModuleDir(model, vpc.configFile), 'modules/vpc')).toBe(true);
  });

  it('dependencyModuleDir follows dev/rds -> dependency vpc -> modules/vpc', () => {
    const rds = model.units.find((u) => u.label === 'dev/rds')!;
    expect(endsWith(dependencyModuleDir(model, rds.configFile, 'vpc'), 'modules/vpc')).toBe(true);
  });

  it('returns null for an unknown dependency name', () => {
    const rds = model.units.find((u) => u.label === 'dev/rds')!;
    expect(dependencyModuleDir(model, rds.configFile, 'nope')).toBeNull();
  });
});
