// Wraps @cdktf/hcl2json and normalizes its output into flat reference entries.
//
// IMPORTANT (see memory hcl2json-behavior): @cdktf/hcl2json is `external` in esbuild and
// loads its WASM via __dirname, so this module must only ever run in the extension host.
import { parse } from '@cdktf/hcl2json';
import type { RefKind } from '../shared/graph';

export interface RawRef {
  kind: RefKind;
  /** dependency / include label, when present. */
  name?: string;
  /** Exact string value from the HCL (literal path, or a `${...}` interpolation). */
  rawValue: string;
}

export interface ParsedTerragrunt {
  refs: RawRef[];
  /** Merged same-file locals, for best-effort `${local.X}` resolution. */
  localsMap: Record<string, unknown>;
  /** dependency label → its mock_outputs attribute keys (for completion fallback). */
  mockOutputs: Record<string, string[]>;
  /** True if hcl2json threw (syntax error / unsupported construct). */
  error?: string;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export async function parseTerragrunt(filePath: string, text: string): Promise<ParsedTerragrunt> {
  let json: Record<string, unknown>;
  try {
    json = await parse(filePath, text);
  } catch (e) {
    return { refs: [], localsMap: {}, mockOutputs: {}, error: e instanceof Error ? e.message : String(e) };
  }

  const refs: RawRef[] = [];
  const mockOutputs: Record<string, string[]> = {};

  // (a) dependency: OBJECT keyed by name -> ARRAY of bodies
  const dep = json.dependency;
  if (dep && typeof dep === 'object' && !Array.isArray(dep)) {
    for (const name of Object.keys(dep)) {
      for (const body of asArray((dep as Record<string, unknown>)[name])) {
        const b = body as Record<string, unknown>;
        if (typeof b?.config_path === 'string') {
          refs.push({ kind: 'dependency', name, rawValue: b.config_path });
        }
        const mo = b?.mock_outputs;
        if (mo && typeof mo === 'object' && !Array.isArray(mo)) {
          mockOutputs[name] = [...(mockOutputs[name] ?? []), ...Object.keys(mo as Record<string, unknown>)];
        }
      }
    }
  }

  // (b) dependencies: bare ARRAY of bodies, each with paths[]
  for (const body of asArray(json.dependencies)) {
    const paths = (body as Record<string, unknown>)?.paths;
    if (Array.isArray(paths)) {
      for (const p of paths) {
        if (typeof p === 'string') {
          refs.push({ kind: 'dependencies', rawValue: p });
        }
      }
    }
  }

  // (c) include: labeled OBJECT keyed by name, OR legacy unlabeled ARRAY
  const inc = json.include;
  if (Array.isArray(inc)) {
    for (const body of inc) {
      const p = (body as Record<string, unknown>)?.path;
      if (typeof p === 'string') {
        refs.push({ kind: 'include', name: '(root)', rawValue: p });
      }
    }
  } else if (inc && typeof inc === 'object') {
    for (const name of Object.keys(inc)) {
      for (const body of asArray((inc as Record<string, unknown>)[name])) {
        const p = (body as Record<string, unknown>)?.path;
        if (typeof p === 'string') {
          refs.push({ kind: 'include', name, rawValue: p });
        }
      }
    }
  }

  // (d) terraform.source: bare ARRAY of bodies
  for (const body of asArray(json.terraform)) {
    const src = (body as Record<string, unknown>)?.source;
    if (typeof src === 'string') {
      refs.push({ kind: 'source', rawValue: src });
    }
  }

  // read_terragrunt_config(...) anywhere (locals / remote_state / inputs / …) → a 'read' ref.
  // hcl2json gives no offsets and folds the call into a ${...} string, so we scan the raw text.
  // Two common argument forms: find_in_parent_folders("NAME") or a literal "PATH".
  const inComment = (idx: number): boolean => {
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
    return /[#]|\/\//.test(text.slice(lineStart, idx));
  };
  const readSeen = new Set<string>();
  const readRe = /read_terragrunt_config\s*\(\s*(find_in_parent_folders\s*\(\s*"[^"]*"\s*\)|"[^"]*")/g;
  let rm: RegExpExecArray | null;
  while ((rm = readRe.exec(text))) {
    if (inComment(rm.index)) {
      continue;
    }
    const arg = rm[1].trim();
    const rawValue = arg.startsWith('"') ? arg.slice(1, -1) : `\${${arg}}`;
    if (readSeen.has(rawValue)) {
      continue;
    }
    readSeen.add(rawValue);
    refs.push({ kind: 'read', rawValue });
  }

  // locals: ARRAY of bodies, merged into one map
  const localsMap: Record<string, unknown> = {};
  for (const body of asArray(json.locals)) {
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        localsMap[k] = v;
      }
    }
  }

  return { refs, localsMap, mockOutputs };
}
