# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension that statically analyzes a Terragrunt project and renders its reference
graph + provides navigation/hover/completion. See `README.md` (or `README.zh-TW.md`) for the
user-facing feature list and `BACKLOG.md` for done/todo.

## Hard rule: static analysis only

NEVER run the `terragrunt` / `terraform` CLI, and never make the extension do so. It only reads
`.hcl` / `.tf` files and parses them with `@cdktf/hcl2json` (WASM). No CLI is invoked, no state is
read, nothing is applied. If a task appears to require running the CLI, ask the user first.

## Commands

- `npm run compile` — build both bundles (`dist/extension.js` + `media/graph.js`) via `esbuild.js`.
- `npm run watch` — esbuild in watch mode.
- `npm run package` — production build (run before `vsce package`).
- `npm run check` — `tsc --noEmit` type-check. Run after edits; it is the source of truth for types.
- `npm test` — vitest, whole suite. `npm run test:watch`, `npm run coverage` (HTML in `coverage/`).
- Run one test file/case: `npx vitest run test/parser.test.ts` or `npx vitest run -t "<name>"`.
- `npx @vscode/vsce package` — build the `.vsix` (CI uses `@vscode/vsce@latest`).
- **F5** (`.vscode/launch.json`) — Extension Development Host with `fixtures/sample-infra/` loaded.
- `npm run probe:parser` / `probe:scanner` — standalone Node probes against the core (no vscode).
  `scripts/` also has unscripted probes run directly with `node` (`probe-docurl.mjs`,
  `probe-malformed.mjs`) for ad-hoc investigation.

## Architecture

**Two separately-bundled worlds** (`esbuild.js`):
- **Extension host**: `src/**` → `dist/extension.js` (node/cjs). `@cdktf/hcl2json` is marked
  **external on purpose** — it loads its WASM via `__dirname`, so esbuild cannot bundle it; it
  ships unbundled in `node_modules` inside the VSIX, and `.vscodeignore` explicitly keeps that
  dependency closure while excluding everything else.
- **Webview**: `media/graph.ts` → `media/graph.js` (browser/iife, bundles cytoscape + dagre).
  `media/graph.js` is a build artifact (gitignored); regenerate with `npm run compile`.

**Layering — preserve it**: `src/core/**` is pure and must NOT import `vscode`, so it runs under
vitest and the probe scripts. `parser` / `resolve` / `scanner` / `moduleIntrospect` /
`completionContext` / `outputRefs` live there. `src/providers/**`, `src/webview/**`, and
`extension.ts` are the vscode shell and route through core. When provider logic is non-trivial,
extract the pure part into a core helper so it stays testable (e.g. `completionContext.classifyCompletion`,
`outputRefs.scanOutputRefs`). `core/model.ts` holds the shared data types (the `buildModel` output
shape) that scanner produces and the providers/webview consume — start there to learn the domain model.

**`parseTerragrunt` (`core/parser.ts`) is the hub** — scanner, navProvider, hoverProvider, and
completionProvider all parse through it. Two non-obvious behaviors:
- hcl2json is **all-or-nothing** (any syntax error → nothing parses). `parser.ts` keeps a
  per-session **last-known-good cache**: on failure it returns the file's last successful parse
  plus the new `error`, so a mid-edit file keeps its index (navigation/hover/completion/graph
  edges). `__resetParseCache()` exists for test isolation.
- hcl2json renders function calls / interpolations as `${...}` strings — e.g. an `include` path
  becomes `${find_in_parent_folders("root.hcl")}`. Resolution and the providers regex-match these.

**`scanner.buildModel` is two-pass**: pass 1 parses every file and indexes its locals by absolute
path; pass 2 resolves references with cross-file locals available via `ResolveCtx.fileLocals`.
The two passes are required because a `read_terragrunt_config` chain may point at a file scanned later.

**Reference relationships are one `RefKind` union** (`shared/graph.ts`): `dependency` /
`dependencies` / `include` / `source` / `read`. `ALL_EDGE_TYPES` drives the webview toolbar
checkboxes and the tree groups, so adding a kind propagates to most UI — but you still add the
edge style (`media/graph.ts` + `media/graph.css`) and the tree group (`treeProvider.ts`).

**Diagnostics** feed one `DiagnosticCollection` from two places: `publishDiagnostics` (whole
project, on save via the FileSystemWatcher → rescan) and `validateDocument` (live, current
document, on type, debounced). rescan re-validates open editors so live-only warnings (e.g.
unknown-output) survive `publishDiagnostics`' clear.

**Resolution** (`core/resolve.ts`) statically evaluates `find_in_parent_folders`, `get_*_dir`,
`path_relative_*`, `${local.x}` (same-file literal), and `${local.x.locals.y}` cross-file via
`read_terragrunt_config`. Genuinely remote/runtime values become unresolved/remote nodes, never
guessed. `include`-merged locals/blocks inherited from a parent are NOT flattened.

**Module introspection** (`core/moduleIntrospect.ts`) parses a module's `*.tf` for `output` /
`variable` names (cached; cleared on rescan); `dependencyModuleDir` / `unitModuleDir` walk the
model to a module dir. This backs hover, completion, and the unknown-output diagnostic — all of
which only report for locally-resolvable modules (remote → skipped, to avoid false positives).
