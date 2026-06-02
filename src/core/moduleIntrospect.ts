// Statically introspects a local Terraform module: its declared `output` and `variable` names.
// Used by the hover + completion providers. .tf files are HCL, so we parse them with the same
// @cdktf/hcl2json WASM parser as terragrunt.hcl (must run in the extension host only).
import { parse } from '@cdktf/hcl2json';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphModel } from './model';

export interface ModuleInterface {
  /** Declared `output "name" {}` names, sorted. */
  outputs: string[];
  /** Declared `variable "name" {}` names, sorted. */
  variables: string[];
}

const EMPTY: ModuleInterface = { outputs: [], variables: [] };
const cache = new Map<string, ModuleInterface>();

/** Drop the introspection cache (call on rescan so module edits are picked up). */
export function clearModuleCache(): void {
  cache.clear();
}

function collectKeys(block: unknown, into: Set<string>): void {
  // hcl2json renders `output "x" {}` / `variable "x" {}` as an object keyed by the label.
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    for (const k of Object.keys(block as Record<string, unknown>)) {
      into.add(k);
    }
  }
}

/** Parse every *.tf in `moduleDir` and return its declared outputs + variables (cached). */
export async function introspectModule(moduleDir: string): Promise<ModuleInterface> {
  const key = path.resolve(moduleDir);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(key, { withFileTypes: true });
  } catch {
    cache.set(key, EMPTY);
    return EMPTY;
  }

  const outputs = new Set<string>();
  const variables = new Set<string>();
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.tf')) {
      continue;
    }
    try {
      const text = await fs.promises.readFile(path.join(key, e.name), 'utf8');
      const json = await parse(e.name, text);
      collectKeys(json.output, outputs);
      collectKeys(json.variable, variables);
    } catch {
      // A malformed .tf just contributes nothing; never throw out of introspection.
    }
  }

  const result: ModuleInterface = {
    outputs: [...outputs].sort(),
    variables: [...variables].sort(),
  };
  cache.set(key, result);
  return result;
}

/** The local module directory that `unitConfigFile`'s own `terraform.source` resolves to, or null. */
export function unitModuleDir(model: GraphModel, unitConfigFile: string): string | null {
  const unit = model.units.find((u) => u.configFile === unitConfigFile);
  const source = unit?.references.find((r) => r.kind === 'source' && r.resolved && !r.remote);
  return source?.targetNodeId ?? null;
}

/**
 * Follow `dependency "<depName>"` in `unitConfigFile` to the local module directory it ultimately
 * uses: dependency → target unit → that unit's terraform.source → module dir. Null if any hop is
 * remote/unresolved (so callers fall back to mock_outputs).
 */
export function dependencyModuleDir(
  model: GraphModel,
  unitConfigFile: string,
  depName: string,
): string | null {
  const unit = model.units.find((u) => u.configFile === unitConfigFile);
  const dep = unit?.references.find((r) => r.kind === 'dependency' && r.name === depName);
  if (!dep) {
    return null;
  }
  return unitModuleDir(model, dep.targetNodeId);
}
