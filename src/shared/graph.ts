// Types shared between the extension host (src/**) and the webview bundle (media/graph.ts).
// Keep this file dependency-free (no `vscode`, no node builtins) so it can be bundled into
// the browser webview as well as the node extension.

/** The Terragrunt reference relationships we model as edges. */
export type RefKind = 'dependency' | 'dependencies' | 'include' | 'source' | 'read';
export type EdgeType = RefKind;

/** What a graph node represents. */
export type NodeKind =
  | 'unit' // a terragrunt.hcl unit
  | 'config' // a non-unit .hcl config file (e.g. root.hcl, env.hcl) — an include or read target
  | 'module' // a local Terraform module directory (terraform.source target)
  | 'external'; // a remote source or an unresolved reference (non-navigable)

export interface GraphNode {
  /** Stable id. For unit/config/module this is an absolute filesystem path; for external it is `external::<raw>`. */
  id: string;
  /** Compact label shown on the node (kept short so it never distorts the layout). */
  label: string;
  /** Full label shown in the hover tooltip (full workspace-relative path, or full raw value). */
  title: string;
  kind: NodeKind;
  /** Absolute path to open when the node is activated; null for external/non-navigable nodes. */
  openPath: string | null;
  /** For remote module sources: a browsable docs/repo URL opened in the browser. */
  openUrl?: string;
  /** True when openPath points at a directory (reveal in explorer) rather than a file. */
  openIsDir: boolean;
  /** True if the referenced path actually exists on disk (best-effort, computed at scan time). */
  exists: boolean;
}

export interface GraphEdge {
  /** id of the referencing unit node (absolute path of its config file). */
  source: string;
  /** id of the referenced node. */
  target: string;
  type: EdgeType;
  /** True when the reference resolved to a concrete local path; false for remote/dynamic/unresolved. */
  resolved: boolean;
  /** dependency / include label, when present. */
  name?: string;
  /** Exact raw value from the HCL (may contain `${...}`). */
  rawValue: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---- Messages: extension host -> webview ----
export interface GraphMessage extends GraphPayload {
  type: 'graph';
}
export interface RevealMessage {
  type: 'reveal';
  id: string;
}
export interface ThemeMessage {
  type: 'theme';
}
export type InboundMessage = GraphMessage | RevealMessage | ThemeMessage;

// ---- Messages: webview -> extension host ----
export interface ReadyMessage {
  type: 'ready';
}
export interface OpenNodeMessage {
  type: 'openNode';
  id: string;
}
export interface NodeSelectedMessage {
  type: 'nodeSelected';
  id: string;
}
export type OutboundMessage = ReadyMessage | OpenNodeMessage | NodeSelectedMessage;

export const ALL_EDGE_TYPES: EdgeType[] = ['dependency', 'dependencies', 'include', 'source', 'read'];
