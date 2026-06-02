// Cmd/Ctrl+Click navigation inside *.hcl files.
//
// hcl2json gives us no byte offsets, so we use the parser only to learn WHICH string
// values are reference-bearing (and of which kind), then re-locate them in the raw text
// via attribute-anchored regexes and convert offsets with document.positionAt().
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseTerragrunt } from '../core/parser';
import { resolveReference, remoteSourceUrl, type ResolveCtx } from '../core/resolve';
import type { RefKind } from '../shared/graph';

interface RefToken {
  range: vscode.Range;
  target: vscode.Uri;
  kind: RefKind;
  rawValue: string;
}

function kindLabel(kind: RefKind): string {
  switch (kind) {
    case 'dependency':
      return 'dependency';
    case 'dependencies':
      return 'run-order dependency';
    case 'include':
      return 'include';
    case 'source':
      return 'module source';
  }
}

/** Scan a document and produce navigable reference tokens (shared by link + definition providers). */
export async function findReferenceTokens(
  document: vscode.TextDocument,
  rootConfigName: string,
): Promise<RefToken[]> {
  const text = document.getText();
  const { refs } = await parseTerragrunt(document.uri.fsPath, text);
  if (refs.length === 0) {
    return [];
  }

  const setOf = (kind: RefKind) => new Set(refs.filter((r) => r.kind === kind).map((r) => r.rawValue));
  const depPaths = setOf('dependency');
  const depsPaths = setOf('dependencies');
  const sourcePaths = setOf('source');

  const currentDir = path.dirname(document.uri.fsPath);
  const workspaceRoot =
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? currentDir;

  const ctxBase: ResolveCtx = {
    currentFile: document.uri.fsPath,
    currentDir,
    workspaceRoot,
    rootConfigName,
    localsMap: {},
  };
  // Resolve includes first to learn parentDir for any get_parent_terragrunt_dir() usage.
  let parentDir: string | null = null;
  for (const r of refs.filter((x) => x.kind === 'include')) {
    const res = resolveReference('include', r.rawValue, ctxBase);
    if (res.resolved && res.targetFile) {
      parentDir = path.dirname(res.targetFile);
      break;
    }
  }
  const ctx: ResolveCtx = { ...ctxBase, parentDir };

  const tokens: RefToken[] = [];

  // value = the string handed to the resolver (may be a ${...} interpolation);
  // rangeStart/rangeLen = where the clickable text sits in the document.
  const emit = (kind: RefKind, value: string, rangeStart: number, rangeLen: number = value.length): void => {
    const res = resolveReference(kind, value, ctx);
    if (!res.resolved || res.remote) {
      return; // remote / dynamic / unresolved → no link
    }
    const openPath = kind === 'source' ? res.targetFile ?? res.resolvedAbsPath : res.targetFile;
    if (!openPath) {
      return;
    }
    const range = new vscode.Range(
      document.positionAt(rangeStart),
      document.positionAt(rangeStart + rangeLen),
    );
    tokens.push({ range, target: vscode.Uri.file(openPath), kind, rawValue: value });
  };

  // Skip matches that sit inside a line comment (# or //) on their line.
  const inComment = (idx: number): boolean => {
    const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
    const before = text.slice(lineStart, idx);
    return before.includes('#') || before.includes('//');
  };

  // Attribute-anchored string scan over `scope` (default whole doc), offset into absolute text.
  // Cross-checks captures against parser values so a string only links if it is a real reference.
  const scan = (re: RegExp, set: Set<string>, kind: RefKind, scope: string = text, offset = 0): void => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(scope))) {
      const value = m[1];
      if (!set.has(value)) {
        continue;
      }
      const matchStart = offset + m.index;
      if (inComment(matchStart)) {
        continue;
      }
      emit(kind, value, matchStart + m[0].indexOf('"') + 1);
    }
  };

  // config_path: attribute name is unique to the dependency block kind.
  scan(/\bconfig_path\s*=\s*"([^"]*)"/g, depPaths, 'dependency');

  // terraform source: local → open the module file/dir; remote → open its docs/repo URL.
  {
    const re = /\bsource\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const value = m[1];
      if (!sourcePaths.has(value)) {
        continue;
      }
      const valueStart = m.index + m[0].indexOf('"') + 1;
      if (inComment(valueStart)) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(valueStart),
        document.positionAt(valueStart + value.length),
      );
      const res = resolveReference('source', value, ctx);
      if (res.resolved && !res.remote) {
        const openPath = res.targetFile ?? res.resolvedAbsPath;
        if (openPath) {
          tokens.push({ range, target: vscode.Uri.file(openPath), kind: 'source', rawValue: value });
        }
      } else if (res.remote) {
        const url = remoteSourceUrl(value);
        if (url) {
          tokens.push({ range, target: vscode.Uri.parse(url), kind: 'source', rawValue: value });
        }
      }
    }
  }

  // include path (literal): a quoted path inside an include { ... } block. Function-call
  // paths like find_in_parent_folders(...) are picked up by the global scan below.
  const includeBlockRe = /\binclude\b[^{]*\{([\s\S]*?)\}/g;
  let ib: RegExpExecArray | null;
  while ((ib = includeBlockRe.exec(text))) {
    const bodyStart = ib.index + ib[0].indexOf('{') + 1;
    const litRe = /\bpath\s*=\s*"([^"]*)"/g;
    let pm: RegExpExecArray | null;
    while ((pm = litRe.exec(ib[1]))) {
      const valueStart = bodyStart + pm.index + pm[0].indexOf('"') + 1;
      if (inComment(valueStart)) {
        continue;
      }
      emit('include', pm[1], valueStart, pm[1].length);
    }
  }

  // Resolve a find_in_parent_folders(...) call to a file for NAVIGATION. Strict upward first
  // (real Terragrunt semantics); then a same-directory fallback so a sibling config — e.g.
  // region.hcl next to root.hcl in read_terragrunt_config(...) — is still clickable.
  const resolveFipf = (call: string): string | null => {
    const res = resolveReference('include', `\${${call}}`, ctx);
    if (res.resolved && res.targetFile) {
      return res.targetFile;
    }
    const nameMatch = call.match(/find_in_parent_folders\s*\(\s*"([^"]*)"/);
    const here = path.join(ctx.currentDir, nameMatch?.[1] ?? ctx.rootConfigName);
    try {
      if (fs.existsSync(here) && fs.statSync(here).isFile()) {
        return here;
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  // find_in_parent_folders(...) ANYWHERE — include paths, read_terragrunt_config in locals,
  // remote_state, inputs, … — links to the config file it resolves to.
  {
    const re = /find_in_parent_folders\s*\([^)]*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (inComment(m.index)) {
        continue;
      }
      const target = resolveFipf(m[0]);
      if (target) {
        tokens.push({
          range: new vscode.Range(document.positionAt(m.index), document.positionAt(m.index + m[0].length)),
          target: vscode.Uri.file(target),
          kind: 'include',
          rawValue: m[0],
        });
      }
    }
  }

  // read_terragrunt_config("literal.hcl") → the referenced config file (relative to this dir).
  {
    const re = /read_terragrunt_config\s*\(\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const valueStart = m.index + m[0].indexOf('"') + 1;
      if (inComment(valueStart)) {
        continue;
      }
      emit('include', m[1], valueStart, m[1].length);
    }
  }

  // dependencies { paths = [ "..", ".." ] } — isolate the array, then scan its strings.
  const arrRe = /\bdependencies\b[\s\S]*?\bpaths\s*=\s*\[([^\]]*)\]/g;
  let a: RegExpExecArray | null;
  while ((a = arrRe.exec(text))) {
    const base = a.index + a[0].indexOf('[') + 1;
    const body = a[1];
    const strRe = /"([^"]*)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(body))) {
      if (!depsPaths.has(sm[1])) {
        continue;
      }
      const valueStart = base + sm.index + 1;
      if (inComment(valueStart)) {
        continue;
      }
      emit('dependencies', sm[1], valueStart);
    }
  }

  return tokens;
}

function rootConfigName(): string {
  return vscode.workspace.getConfiguration('terragruntTrace').get<string>('rootConfigName', 'terragrunt.hcl');
}

export class TerragruntLinkProvider implements vscode.DocumentLinkProvider {
  async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
    const tokens = await findReferenceTokens(document, rootConfigName());
    return tokens.map((t) => {
      const link = new vscode.DocumentLink(t.range, t.target);
      const isWeb = t.target.scheme === 'http' || t.target.scheme === 'https';
      link.tooltip = isWeb
        ? `Terragrunt ${kindLabel(t.kind)} → open docs (${t.target.toString()})`
        : `Terragrunt ${kindLabel(t.kind)} → ${vscode.workspace.asRelativePath(t.target)}`;
      return link;
    });
  }
}

export class TerragruntDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.LocationLink[] | undefined> {
    const tokens = await findReferenceTokens(document, rootConfigName());
    const hit = tokens.find((t) => t.range.contains(position));
    if (!hit) {
      return undefined;
    }
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      {
        originSelectionRange: hit.range,
        targetUri: hit.target,
        targetRange: top,
        targetSelectionRange: top,
      },
    ];
  }
}
