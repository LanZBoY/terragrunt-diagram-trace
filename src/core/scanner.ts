// Builds the dependency graph model from a set of *.hcl files.
//
// This module is intentionally free of any `vscode` import so it can be exercised
// directly by scripts/probe-scanner.mjs. The extension supplies the file list
// (via vscode.workspace.findFiles) and reads via fs here.
import * as fs from 'fs';
import * as path from 'path';
import type { GraphNode, NodeKind } from '../shared/graph';
import type { GraphModel, ResolvedReference, Unit } from './model';
import { parseTerragrunt } from './parser';
import { resolveReference, remoteSourceUrl, type ResolveCtx } from './resolve';

export interface ScanOptions {
  rootConfigName: string;
}

const DEFAULT_EXCLUDES = ['.terragrunt-cache', '.terraform', 'node_modules', '.git'];

/** Longest-prefix workspace root that contains `p`, else the first root, else dirname(p). */
function owningRoot(p: string, roots: string[]): string {
  let best = '';
  for (const r of roots) {
    const rr = path.resolve(r);
    if ((p === rr || p.startsWith(rr + path.sep)) && rr.length > best.length) {
      best = rr;
    }
  }
  return best || roots[0] || path.dirname(p);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Workspace-relative label. For a terragrunt.hcl, label by its directory; otherwise by the file. */
function relLabel(target: string, roots: string[], asUnit: boolean): string {
  const root = owningRoot(target, roots);
  const base = asUnit && path.basename(target) === 'terragrunt.hcl' ? path.dirname(target) : target;
  const rel = path.relative(root, base);
  if (rel === '') {
    return path.basename(root);
  }
  return toPosix(rel);
}

function existsOnDisk(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function shorten(value: string, max = 60): string {
  const v = value.trim();
  if (v.length <= max) {
    return v;
  }
  return v.slice(0, max - 1) + '…';
}

/** Compact label for a graph node so long paths never blow up the layout (full path goes in title). */
function compactLabel(full: string, maxSegs = 2): string {
  const parts = full.split('/').filter(Boolean);
  if (parts.length <= maxSegs) {
    return full;
  }
  return '…/' + parts.slice(-maxSegs).join('/');
}

/** Compact label for a remote/unresolved external node: keep just the module-ish tail. */
function compactExternal(raw: string): string {
  let s = raw.trim().replace(/\?.*$/, ''); // strip ?ref=…
  const dslash = s.lastIndexOf('//');
  if (dslash >= 0) {
    s = s.slice(dslash + 2);
  }
  const slash = s.lastIndexOf('/');
  if (slash >= 0) {
    s = s.slice(slash + 1);
  }
  s = s.replace(/\$\{[^}]*\}/g, '').trim();
  return s ? shorten(s, 28) : shorten(raw, 28);
}

function fileNodeKind(p: string): NodeKind {
  return path.basename(p) === 'terragrunt.hcl' ? 'unit' : 'config';
}

export async function buildModel(files: string[], workspaceRoots: string[], opts: ScanOptions): Promise<GraphModel> {
  const roots = workspaceRoots.map((r) => path.resolve(r));
  const nodeMap = new Map<string, GraphNode>();
  const units: Unit[] = [];

  const ensureNode = (node: GraphNode): void => {
    const existing = nodeMap.get(node.id);
    if (!existing) {
      nodeMap.set(node.id, node);
      return;
    }
    // Merge: a real on-disk presence and a non-external kind win.
    existing.exists = existing.exists || node.exists;
    if (existing.kind === 'external' && node.kind !== 'external') {
      nodeMap.set(node.id, { ...node, exists: existing.exists });
    }
  };

  for (const file of files) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const { refs, localsMap, error } = await parseTerragrunt(file, text);
    const dir = path.dirname(file);
    const root = owningRoot(file, roots);

    // The referencing unit is always a node.
    const fileFull = relLabel(file, roots, true);
    ensureNode({
      id: file,
      label: compactLabel(fileFull),
      title: fileFull,
      kind: fileNodeKind(file),
      openPath: file,
      openIsDir: false,
      exists: existsOnDisk(file),
    });

    const ctxBase: ResolveCtx = {
      currentFile: file,
      currentDir: dir,
      workspaceRoot: root,
      rootConfigName: opts.rootConfigName,
      localsMap,
    };

    // First resolve includes to learn parentDir (backs get_parent_terragrunt_dir / path_relative_*).
    let parentDir: string | null = null;
    for (const ref of refs) {
      if (ref.kind === 'include') {
        const res = resolveReference('include', ref.rawValue, ctxBase);
        if (res.resolved && res.targetFile) {
          parentDir = path.dirname(res.targetFile);
          break;
        }
      }
    }
    const ctx: ResolveCtx = { ...ctxBase, parentDir };

    const references: ResolvedReference[] = [];
    for (const ref of refs) {
      const res = resolveReference(ref.kind, ref.rawValue, ctx);

      let targetNodeId: string;
      let openPath: string | null = null;
      let openIsDir = false;
      let targetExists = false;
      let targetLabel: string;
      let docUrl: string | undefined;

      if (res.remote || !res.resolved) {
        // Non-navigable on disk. A remote module source still gets a browsable docs URL.
        docUrl = ref.kind === 'source' && res.remote ? remoteSourceUrl(ref.rawValue) ?? undefined : undefined;
        targetNodeId = `external::${ref.rawValue}`;
        targetLabel = shorten(ref.rawValue);
        ensureNode({
          id: targetNodeId,
          label: compactExternal(ref.rawValue),
          title: ref.rawValue,
          kind: 'external',
          openPath: null,
          openUrl: docUrl,
          openIsDir: false,
          exists: false,
        });
      } else if (ref.kind === 'source') {
        // Local Terraform module directory.
        const moduleDir = res.resolvedAbsPath as string;
        targetNodeId = moduleDir;
        openPath = res.targetFile ?? moduleDir; // main.tf if present, else the directory
        openIsDir = res.targetFile === null;
        targetExists = existsOnDisk(moduleDir);
        targetLabel = relLabel(moduleDir, roots, false);
        ensureNode({
          id: targetNodeId,
          label: compactLabel(targetLabel),
          title: targetLabel,
          kind: 'module',
          openPath,
          openIsDir,
          exists: targetExists,
        });
      } else {
        // dependency / dependencies / include → a config file.
        const targetFile = res.targetFile as string;
        targetNodeId = targetFile;
        openPath = targetFile;
        openIsDir = false;
        targetExists = existsOnDisk(targetFile);
        targetLabel = relLabel(targetFile, roots, true);
        ensureNode({
          id: targetNodeId,
          label: compactLabel(targetLabel),
          title: targetLabel,
          kind: fileNodeKind(targetFile),
          openPath: targetFile,
          openIsDir: false,
          exists: targetExists,
        });
      }

      references.push({
        kind: ref.kind,
        name: ref.name,
        rawValue: ref.rawValue,
        resolved: res.resolved && !res.remote,
        remote: res.remote,
        reason: res.reason,
        targetNodeId,
        openPath,
        openIsDir,
        docUrl,
        exists: targetExists,
        targetLabel,
      });
    }

    units.push({ configFile: file, dir, label: relLabel(file, roots, true), references, parseError: error });
  }

  // Edges: one per reference, deduped by source->target:type (keeps the first).
  const edgeSeen = new Set<string>();
  const edges: GraphModel['edges'] = [];
  for (const unit of units) {
    for (const ref of unit.references) {
      const key = `${unit.configFile}->${ref.targetNodeId}:${ref.kind}`;
      if (edgeSeen.has(key)) {
        continue;
      }
      edgeSeen.add(key);
      edges.push({
        source: unit.configFile,
        target: ref.targetNodeId,
        type: ref.kind,
        resolved: ref.resolved,
        name: ref.name,
        rawValue: ref.rawValue,
      });
    }
  }

  const visibleUnits = units
    .filter((u) => u.references.length > 0 || !!u.parseError)
    .sort((a, b) => a.label.localeCompare(b.label));

  return { units: visibleUnits, nodes: [...nodeMap.values()], edges };
}

/** Recursively collect *.hcl files under the given roots (used by the standalone test script). */
export function walkHclFiles(roots: string[], excludeNames: string[] = DEFAULT_EXCLUDES): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (excludeNames.includes(entry.name)) {
          continue;
        }
        visit(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.hcl')) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  for (const r of roots) {
    visit(path.resolve(r));
  }
  return out;
}
