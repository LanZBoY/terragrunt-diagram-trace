# Terragrunt Diagram & Trace

[![CI](https://github.com/LanZBoY/terragrunt-diagram-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/LanZBoY/terragrunt-diagram-trace/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A VS Code extension that scans a Terragrunt project, draws its **reference graph**, and
lets you **jump straight to referenced files**.

> **Static analysis only.** This extension never runs `terragrunt` / `terraform`. It only
> reads `.hcl` files and parses them with a WebAssembly HCL parser
> ([`@cdktf/hcl2json`](https://www.npmjs.com/package/@cdktf/hcl2json)). No CLI is invoked,
> no state is touched, nothing is applied.

## Screenshots

> _Screenshots / GIFs go here — capture them from the Extension Development Host (press **F5**)
> with `fixtures/sample-infra/` loaded, and drop the files under `media/screenshots/`._

| Dependency graph | Click-to-jump navigation |
| --- | --- |
| _`media/screenshots/graph.png`_ | _`media/screenshots/jump.gif`_ |

## Features

### 1. Dependency graph (interactive webview)
Run **`Terragrunt: Show Dependency Graph`** to open a Cytoscape graph laid out top-down
(dagre). It visualizes all four Terragrunt reference relationships, each with a distinct
edge style:

| Edge | Meaning | Style |
| --- | --- | --- |
| `dependency` | `dependency "x" { config_path = … }` — data dependency + run order | solid blue |
| `dependencies` | `dependencies { paths = […] }` — run-order only | dashed gray |
| `include` | `include { path = find_in_parent_folders(…) }` — config inheritance | dotted purple |
| `source` | `terraform { source = … }` — the Terraform module | solid green |

Unresolved / remote edges (e.g. a `git::` module source, or a `config_path` built from a
runtime value) are drawn **dashed red** and point at a diamond "external" node.

- **Focus mode** — **tap a node** to show only its neighborhood (relationships within N hops),
  so a large graph stays readable. Pick the depth in the toolbar (*neighbors / 2 hops /
  all linked*); **Show all** clears the focus. The focused node is outlined in yellow.
- **Double-tap a node** to open its underlying file (and reveal it in the tree). Double-tapping
  a remote-source node opens that module's docs/repository in the browser.
- **Toolbar** also filters edges by type, fits the view, and re-runs the layout.
- Colors follow your active VS Code theme (light / dark / high-contrast).

### 2. Quick navigation to referenced files
- **Cmd/Ctrl+Click** (or hover → click) any reference to jump straight to it: a
  `config_path`, a `dependencies` `paths[]` entry, an `include` path (a literal **or**
  `find_in_parent_folders("root.hcl")` — the whole call is clickable), and a
  `terraform.source`. A **local** source opens the module file; a **remote** source
  (git / GitHub / GitLab / Bitbucket / Terraform Registry) opens its docs/repository in the
  browser. Backed by a `DocumentLinkProvider`.
- A `find_in_parent_folders(...)` call is clickable **anywhere** it appears — including inside
  a `read_terragrunt_config(...)` in a `locals` block — as is a `read_terragrunt_config("…")`
  literal. (For navigation this also falls back to a same-directory match, so a sibling config
  like `region.hcl` next to `root.hcl` stays clickable even though `find_in_parent_folders` is
  strictly upward in real Terragrunt.)
- **F12 / Go to Definition / Peek** on the same strings, via a `DefinitionProvider`.
- **Right-click a `.hcl` file** (in the editor or the Explorer) → **Show Related Modules in
  Graph** opens the graph focused on that file's relationships. Also available by
  right-clicking a unit in the Reference Tree.
- Relative paths resolve against the file's own directory; a dependency directory opens its
  `terragrunt.hcl`; a local module source opens its `main.tf` (or reveals the folder).

### 3. Reference tree (Activity Bar)
The **Terragrunt Trace** view lists every unit, grouped by relationship
(*Dependencies / Run-order / Includes / Source*). Click a leaf to jump to the target.
Remote sources show a ☁ icon; unresolved references show a `?`.

## Getting started (development)

```bash
npm install
npm run compile      # build dist/extension.js + media/graph.js
```

Press **F5** (uses `.vscode/launch.json`) to open an Extension Development Host with the
bundled `fixtures/sample-infra/` project loaded, then:

- open the **Terragrunt Trace** view in the Activity Bar, or
- run **`Terragrunt: Show Dependency Graph`** from the Command Palette, or
- Cmd/Ctrl+Click a path inside any `dev/*/terragrunt.hcl`.

## Testing

Unit + integration tests run on [vitest](https://vitest.dev) and exercise the parser,
resolver, and graph builder against `fixtures/sample-infra/` — still **static analysis only**,
no `terragrunt` / `terraform` CLI is invoked.

```bash
npm test           # run the suite once
npm run test:watch # watch mode
npm run coverage   # text summary + HTML report in coverage/
```

CI (`.github/workflows/ci.yml`) runs the type-check, the test suite, and packages the VSIX on
every push / PR — the results are published as a **Vitest Report** check and coverage is
uploaded as a build artifact. Pushing a version tag (`v*`) builds the VSIX and attaches it to a
GitHub Release via `.github/workflows/release.yml`.

## What gets resolved

The resolver statically evaluates the Terragrunt functions that commonly appear in path
fields:

- `find_in_parent_folders()` / `find_in_parent_folders("name.hcl")` — strict upward walk,
  bounded by the workspace folder.
- `get_terragrunt_dir()`, `get_original_terragrunt_dir()`, `get_repo_root()`,
  `get_path_to_repo_root()`.
- `get_parent_terragrunt_dir()`, `path_relative_to_include()`, `path_relative_from_include()`
  (best-effort, derived from the resolved `include`).
- `${local.x}` references whose value is a literal string in the same file.

Anything genuinely runtime-only (`read_terragrunt_config(...)`, `dependency.x.outputs.y`,
`get_env(...)`, `run_cmd(...)`, registry/remote module sources) is shown as an
**unresolved / remote** node rather than guessed.

## Malformed files

Each `.hcl` file is parsed independently, so one broken file never breaks the rest of the
graph. A genuine HCL **syntax error** (e.g. an unclosed block) is *surfaced*, not guessed:

- the unit appears in the **Reference Tree** with a ⚠ icon and the error in its tooltip,
- the error is reported in the **Problems** panel with the line/column (when hcl2json
  provides it),
- the rest of the project still renders.

Valid HCL whose references are remote or runtime-dynamic renders normally, with those edges
drawn as unresolved (dashed red) rather than dropped.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `terragruntTrace.scan.exclude` | `**/.terragrunt-cache/**`, `**/.terraform/**`, `**/node_modules/**`, `**/.git/**` | Globs excluded when scanning for `.hcl` files. |
| `terragruntTrace.rootConfigName` | `terragrunt.hcl` | Default filename for `find_in_parent_folders()` with no argument. Set to `root.hcl` if that's your root config convention. |

## Architecture

```
src/
  core/
    parser.ts     parse a terragrunt.hcl via @cdktf/hcl2json → flat refs + locals
    resolve.ts    resolve config_path / paths / include / source → absolute paths
    scanner.ts    walk the workspace, build the node/edge graph model
    model.ts      shared model types
  providers/
    navProvider.ts   DocumentLink + Definition (Cmd+Click / F12)
    treeProvider.ts  Activity Bar TreeDataProvider
  webview/
    panel.ts      webview lifecycle + messaging
  shared/graph.ts  types shared between extension host and webview
media/
  graph.ts        Cytoscape + dagre rendering (bundled to graph.js for the webview)
```

`@cdktf/hcl2json` is intentionally **not bundled** (it loads its WASM blob via `__dirname`);
it ships unbundled in `node_modules` inside the VSIX. See `esbuild.js` and `.vscodeignore`.

## Limitations

- Dependency resolution is static and best-effort; deeply dynamic paths are reported as
  unresolved rather than guessed.
- `include`-merged `dependency`/`source` blocks inherited from a parent are not flattened —
  only references written in each file are shown.

## License

MIT — see [LICENSE](LICENSE).
