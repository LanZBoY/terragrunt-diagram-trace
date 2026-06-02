// Resolves Terragrunt reference values (config_path / paths[] / include.path / source)
// to absolute filesystem paths. Pure logic over { file path, workspace root } + fs reads.
import * as fs from 'fs';
import * as path from 'path';
import type { RefKind } from '../shared/graph';

export interface ResolveCtx {
  /** Absolute path of the terragrunt.hcl being analyzed. */
  currentFile: string;
  /** dirname(currentFile) — the "terragrunt dir"; all relative paths resolve against this. */
  currentDir: string;
  /** Owning workspace folder root; bounds the upward walk of find_in_parent_folders(). */
  workspaceRoot: string;
  /** Config filename find_in_parent_folders() searches for by default. */
  rootConfigName: string;
  /** Merged same-file locals (best-effort interpolation resolution). */
  localsMap: Record<string, unknown>;
  /** dirname of the first resolved include, if any — backs get_parent_terragrunt_dir() etc. */
  parentDir?: string | null;
  /**
   * Resolve another config file's merged locals, for cross-file `${local.x.locals.y}` where
   * `local.x = read_terragrunt_config(<other file>)`. Supplied by the scanner; absent in
   * single-file contexts (navProvider), in which case cross-file chains stay unresolved.
   */
  fileLocals?: (absHclPath: string) => Record<string, unknown> | undefined;
}

export interface ResolutionResult {
  /** Absolute resolved path (file or directory); null if remote/unresolvable. */
  resolvedAbsPath: string | null;
  /** Absolute file to open when navigating; null for module dirs / remote / unresolved. */
  targetFile: string | null;
  /** True if a non-navigable remote terraform source. */
  remote: boolean;
  /** True only when a concrete local path was produced. */
  resolved: boolean;
  /** Why not resolved / why best-effort. */
  reason?: string;
  /**
   * For a source that interpolated to a concrete REMOTE value (e.g. a git URL assembled from
   * cross-file locals): the fully substituted string, so the scanner can derive a docs URL from
   * it rather than from the raw `${...}` value. Absent for local / still-dynamic results.
   */
  resolvedValue?: string;
}

const INTERP = /\$\{([^}]+)\}/g;
/** A Terragrunt *unit* config is always named terragrunt.hcl, regardless of the root config name. */
const UNIT_CONFIG_NAME = 'terragrunt.hcl';
const REMOTE_PREFIX = /^(git|hg|s3|gcs|http|https|ssh|file)::/i;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const TFR = /^tfr:\/\//i;
const HOST_SHORTHAND = /^(github\.com|gitlab\.com|bitbucket\.org)\//i;
const SCP = /^[^/\s]+@[^/\s]+:/; // git@host:org/repo

function configNames(ctx: ResolveCtx): string[] {
  const set = new Set(['terragrunt.hcl', 'root.hcl', ctx.rootConfigName]);
  return [...set];
}

/** Walk STRICTLY upward (parent dirs only) for the nearest `name`, bounded by workspaceRoot. */
export function resolveFindInParentFolders(currentDir: string, name: string, workspaceRoot: string): string | null {
  let dir = path.dirname(currentDir); // strict: same dir does not count
  const stopAt = path.resolve(workspaceRoot);
  // Walk up to and including workspaceRoot, then stop — never probe outside it.
  while (true) {
    const resolvedDir = path.resolve(dir);
    const rel = path.relative(stopAt, resolvedDir);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      break; // escaped the workspace folder (e.g. a unit living at the root)
    }
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* ignore stat races */
    }
    if (resolvedDir === stopAt) {
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // filesystem root
    }
    dir = parent;
  }
  return null;
}

/** Walk upward for a `.git` entry; returns the repo root dir or null. */
function resolveRepoRoot(currentDir: string): string | null {
  let dir = currentDir;
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function resolveLocalToken(expr: string, ctx: ResolveCtx, visited: Set<string>): string | undefined {
  const parts = expr.split('.');
  if (parts[0] !== 'local') {
    return undefined;
  }

  // local.<x>.locals.<y> — a value read from another config in THIS file's locals, i.e.
  // local.x = read_terragrunt_config(<other file>). Needs the scanner-supplied fileLocals.
  if (parts.length === 4 && parts[2] === 'locals') {
    const readExpr = ctx.localsMap[parts[1]];
    if (typeof readExpr !== 'string' || !ctx.fileLocals) {
      return undefined;
    }
    const m = readExpr.match(/^\$\{\s*read_terragrunt_config\((.+)\)\s*\}$/);
    if (!m) {
      return undefined;
    }
    const argRaw = m[1].trim();
    const readRaw = argRaw.startsWith('"') ? argRaw.slice(1, -1) : `\${${argRaw}}`;
    const res = resolveReadConfig(readRaw, ctx);
    if (!res.resolved || !res.targetFile) {
      return undefined;
    }
    const otherLocals = ctx.fileLocals(res.targetFile);
    const val = otherLocals?.[parts[3]];
    if (typeof val !== 'string') {
      return undefined;
    }
    if (!val.includes('${')) {
      return val;
    }
    // The other file's local may itself interpolate — resolve it against that file's context.
    const otherCtx: ResolveCtx = {
      ...ctx,
      currentFile: res.targetFile,
      currentDir: path.dirname(res.targetFile),
      localsMap: otherLocals ?? {},
    };
    const sub = substituteInterpolations(val, otherCtx, visited);
    return sub.dynamic ? undefined : sub.value;
  }

  if (parts.length !== 2) {
    return undefined; // deeper / other nested attr access → not statically indexable
  }
  const key = parts[1];
  const v = ctx.localsMap[key];
  if (typeof v !== 'string') {
    return undefined;
  }
  if (!v.includes('${')) {
    return v;
  }
  if (visited.has(key)) {
    return undefined; // cycle guard
  }
  visited.add(key);
  const sub = substituteInterpolations(v, ctx, visited);
  return sub.dynamic ? undefined : sub.value;
}

/** Replace every `${...}` token with its statically resolved value. dynamic=true if any token is unresolvable. */
export function substituteInterpolations(
  raw: string,
  ctx: ResolveCtx,
  visited: Set<string> = new Set(),
): { value: string; dynamic: boolean } {
  let dynamic = false;
  const value = raw.replace(INTERP, (_m, body: string) => {
    const e = body.trim();

    if (e === 'get_terragrunt_dir()' || e === 'get_original_terragrunt_dir()') {
      return ctx.currentDir;
    }

    const fipf = e.match(/^find_in_parent_folders\(\s*(?:"([^"]*)")?\s*(?:,[^)]*)?\)$/);
    if (fipf) {
      const name = fipf[1] || ctx.rootConfigName;
      const found = resolveFindInParentFolders(ctx.currentDir, name, ctx.workspaceRoot);
      if (found) {
        return found;
      }
      dynamic = true;
      return _m;
    }

    if (e === 'get_parent_terragrunt_dir()') {
      if (ctx.parentDir) {
        return ctx.parentDir;
      }
      dynamic = true;
      return _m;
    }
    if (e === 'path_relative_to_include()') {
      if (ctx.parentDir) {
        return path.relative(ctx.parentDir, ctx.currentDir);
      }
      dynamic = true;
      return _m;
    }
    if (e === 'path_relative_from_include()') {
      if (ctx.parentDir) {
        return path.relative(ctx.currentDir, ctx.parentDir);
      }
      dynamic = true;
      return _m;
    }
    if (e === 'get_repo_root()') {
      const root = resolveRepoRoot(ctx.currentDir);
      if (root) {
        return root;
      }
      dynamic = true;
      return _m;
    }
    if (e === 'get_path_to_repo_root()') {
      const root = resolveRepoRoot(ctx.currentDir);
      if (root) {
        return path.relative(ctx.currentDir, root) || '.';
      }
      dynamic = true;
      return _m;
    }

    if (e.startsWith('local.')) {
      const resolved = resolveLocalToken(e, ctx, visited);
      if (resolved !== undefined) {
        return resolved;
      }
      dynamic = true;
      return _m;
    }

    // read_terragrunt_config(...), dependency.*.outputs.*, get_env(...), run_cmd(...), arithmetic, etc.
    dynamic = true;
    return _m;
  });
  return { value, dynamic };
}

/** Decide file-vs-directory for a resolved config_path / paths[] target. */
function dirOrFileTarget(abs: string, ctx: ResolveCtx): string {
  try {
    const st = fs.existsSync(abs) ? fs.statSync(abs) : undefined;
    if (st?.isFile()) {
      return abs;
    }
    if (st?.isDirectory()) {
      // A dependency points at a unit directory; its config is always terragrunt.hcl
      // (NOT rootConfigName, which is only the included root/parent config name).
      return path.join(abs, UNIT_CONFIG_NAME);
    }
  } catch {
    /* fall through to heuristic */
  }
  // Not on disk yet — heuristic: a config filename / .hcl is a file; otherwise a unit directory.
  if (abs.endsWith('.hcl') || configNames(ctx).includes(path.basename(abs))) {
    return abs;
  }
  return path.join(abs, UNIT_CONFIG_NAME);
}

function resolvePathExpr(raw: string, ctx: ResolveCtx): { abs: string } | { dynamic: true } {
  let value = raw;
  if (raw.includes('${')) {
    const sub = substituteInterpolations(raw, ctx);
    if (sub.dynamic || sub.value.includes('${')) {
      return { dynamic: true };
    }
    value = sub.value;
  }
  return { abs: path.resolve(ctx.currentDir, value) };
}

/** config_path (dependency) / paths[] (dependencies): target dir's config file. */
export function resolveConfigPath(raw: string, ctx: ResolveCtx): ResolutionResult {
  const r = resolvePathExpr(raw, ctx);
  if ('dynamic' in r) {
    return { resolvedAbsPath: null, targetFile: null, remote: false, resolved: false, reason: 'dynamic-function' };
  }
  const targetFile = dirOrFileTarget(r.abs, ctx);
  return { resolvedAbsPath: r.abs, targetFile, remote: false, resolved: true };
}

/** include.path: target is the included .hcl file. */
export function resolveIncludePath(raw: string, ctx: ResolveCtx): ResolutionResult {
  const r = resolvePathExpr(raw, ctx);
  if ('dynamic' in r) {
    return { resolvedAbsPath: null, targetFile: null, remote: false, resolved: false, reason: 'dynamic-function' };
  }
  // include targets a file; only treat as a directory if it really is one on disk.
  let targetFile = r.abs;
  try {
    if (fs.existsSync(r.abs) && fs.statSync(r.abs).isDirectory()) {
      targetFile = path.join(r.abs, ctx.rootConfigName);
    }
  } catch {
    /* keep file target */
  }
  return { resolvedAbsPath: r.abs, targetFile, remote: false, resolved: true };
}

/**
 * Same-directory fallback for a find_in_parent_folders("NAME") call: a sibling NAME next to the
 * current file. Strictly upward (real Terragrunt) never matches a same-dir config like region.hcl
 * sitting next to root.hcl, so read resolution falls back to it (mirrors navProvider navigation).
 */
function findInSameDir(raw: string, ctx: ResolveCtx): string | null {
  const name = raw.match(/find_in_parent_folders\s*\(\s*"([^"]*)"/)?.[1];
  if (!name) {
    return null;
  }
  const here = path.join(ctx.currentDir, name);
  try {
    if (fs.existsSync(here) && fs.statSync(here).isFile()) {
      return here;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** read_terragrunt_config(<arg>): the referenced .hcl config file. */
export function resolveReadConfig(raw: string, ctx: ResolveCtx): ResolutionResult {
  const r = resolvePathExpr(raw, ctx);
  if ('dynamic' in r) {
    const fallback = findInSameDir(raw, ctx);
    if (fallback) {
      return { resolvedAbsPath: fallback, targetFile: fallback, remote: false, resolved: true };
    }
    return { resolvedAbsPath: null, targetFile: null, remote: false, resolved: false, reason: 'dynamic-function' };
  }
  // read always targets a file (the other config), never a unit directory.
  return { resolvedAbsPath: r.abs, targetFile: r.abs, remote: false, resolved: true };
}

export interface SourceClass {
  remote: boolean;
  localDir?: string;
}

/** Classify a terraform.source as remote vs local, applying the go-getter `//` subdir split for local paths. */
export function classifySource(source: string, currentDir: string): SourceClass {
  const s = source.trim();
  const isLocal =
    s.startsWith('./') ||
    s.startsWith('../') ||
    s === '.' ||
    s.startsWith('/') ||
    s.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(s); // Windows drive-letter absolute path
  if (!isLocal || REMOTE_PREFIX.test(s) || SCHEME.test(s) || TFR.test(s) || HOST_SHORTHAND.test(s) || SCP.test(s)) {
    return { remote: true };
  }
  const noQuery = s.includes('?') ? s.slice(0, s.indexOf('?')) : s;
  // Find the first '//' that is NOT a scheme separator (preceded by ':').
  let idx = -1;
  let search = 0;
  while (true) {
    const i = noQuery.indexOf('//', search);
    if (i < 0) {
      break;
    }
    if (i > 0 && noQuery[i - 1] === ':') {
      search = i + 2;
      continue;
    }
    idx = i;
    break;
  }
  // Only split into base//subdir when a real base segment precedes '//' (idx > 0);
  // a leading '//' (idx === 0) keeps the whole path rather than re-rooting under currentDir.
  const base = idx > 0 ? noQuery.slice(0, idx) : noQuery;
  const sub = idx > 0 ? noQuery.slice(idx + 2) : '';
  return { remote: false, localDir: path.resolve(currentDir, base, sub) };
}

/** terraform.source: local module directory (navigable) or remote (not). */
export function resolveSource(raw: string, ctx: ResolveCtx): ResolutionResult {
  let value = raw;
  if (raw.includes('${')) {
    const sub = substituteInterpolations(raw, ctx);
    if (sub.dynamic || sub.value.includes('${')) {
      // Could not statically resolve — most commonly a remote source built from locals.
      return { resolvedAbsPath: null, targetFile: null, remote: true, resolved: false, reason: 'dynamic-source' };
    }
    value = sub.value;
  }
  const cls = classifySource(value, ctx.currentDir);
  if (cls.remote || !cls.localDir) {
    return { resolvedAbsPath: null, targetFile: null, remote: true, resolved: false, reason: 'remote-source', resolvedValue: value };
  }
  // Local module directory. Prefer main.tf as the open target; otherwise the directory itself.
  let targetFile: string | null = null;
  try {
    const mainTf = path.join(cls.localDir, 'main.tf');
    if (fs.existsSync(mainTf) && fs.statSync(mainTf).isFile()) {
      targetFile = mainTf;
    }
  } catch {
    /* ignore */
  }
  return { resolvedAbsPath: cls.localDir, targetFile, remote: false, resolved: true };
}

/**
 * Best-effort browsable documentation/repository URL for a REMOTE terraform source
 * (git host, Terraform Registry, generic https). Returns null when it can't build one
 * (e.g. the source is assembled from a dynamic ${...} value).
 */
export function remoteSourceUrl(source: string): string | null {
  let s = source.trim();
  if (!s || s.includes('${')) {
    return null;
  }

  // Pull ref / version out of the query string.
  let ref: string | undefined;
  let version: string | undefined;
  const qi = s.indexOf('?');
  if (qi >= 0) {
    for (const pair of s.slice(qi + 1).split('&')) {
      const eq = pair.indexOf('=');
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : '';
      if (k === 'ref') {
        ref = decodeURIComponent(v);
      } else if (k === 'version') {
        version = decodeURIComponent(v);
      }
    }
    s = s.slice(0, qi);
  }

  const forcedTfr = /^tfr:\/\//i.test(s);
  s = s.replace(/^[a-z0-9]+::/i, ''); // strip forced getter prefix git:: / hg:: / s3:: …

  // Separate the go-getter //subdir (first // that is not the scheme separator).
  let subdir = '';
  const scheme = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//);
  const dd = s.indexOf('//', scheme ? scheme[0].length : 0);
  if (dd >= 0) {
    subdir = s.slice(dd + 2).replace(/\/+$/, '');
    s = s.slice(0, dd);
  }

  // Terraform Registry: tfr:// or registry.terraform.io or a bare NAMESPACE/NAME/PROVIDER.
  const tfrBody = s.replace(/^tfr:\/\//i, '').replace(/^registry\.terraform\.io\//i, '');
  const reg = tfrBody.match(/^([\w.-]+)\/([\w.-]+)\/([\w.-]+)$/);
  if (reg && (forcedTfr || /registry\.terraform\.io/i.test(source) || (!scheme && !s.includes('@') && !reg[1].includes('.')))) {
    return `https://registry.terraform.io/modules/${reg[1]}/${reg[2]}/${reg[3]}/${version ?? 'latest'}`;
  }

  // Normalize SCP (git@host:owner/repo) and ssh:// / git:// to https.
  const scp = s.match(/^[^@/\s]+@([^:]+):(.+)$/);
  if (scp) {
    s = `https://${scp[1]}/${scp[2]}`;
  }
  s = s.replace(/^ssh:\/\//i, 'https://').replace(/^git:\/\//i, 'https://');

  let host: string;
  let repoPath: string;
  const httpM = s.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (httpM) {
    host = httpM[1];
    repoPath = httpM[2];
  } else {
    const bare = s.match(/^([^/\s]+\.[^/\s]+)\/(.+)$/); // host.tld/owner/repo (e.g. github.com/org/repo)
    if (!bare) {
      return null;
    }
    host = bare[1];
    repoPath = bare[2];
  }
  repoPath = repoPath.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!repoPath) {
    return null;
  }

  if (/^(github\.com|gitlab\.com|bitbucket\.org)$/i.test(host)) {
    if (ref && subdir) {
      return `https://${host}/${repoPath}/tree/${ref}/${subdir}`;
    }
    if (ref) {
      return `https://${host}/${repoPath}/tree/${ref}`;
    }
    return `https://${host}/${repoPath}`;
  }
  return `https://${host}/${repoPath}`; // generic git host over http(s)
}

export function resolveReference(kind: RefKind, rawValue: string, ctx: ResolveCtx): ResolutionResult {
  switch (kind) {
    case 'dependency':
    case 'dependencies':
      return resolveConfigPath(rawValue, ctx);
    case 'include':
      return resolveIncludePath(rawValue, ctx);
    case 'source':
      return resolveSource(rawValue, ctx);
    case 'read':
      return resolveReadConfig(rawValue, ctx);
  }
}
