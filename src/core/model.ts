import type { GraphNode, GraphEdge, RefKind } from '../shared/graph';

/** A single reference (one edge) after resolution, enriched for both tree and graph use. */
export interface ResolvedReference {
  kind: RefKind;
  name?: string;
  rawValue: string;
  resolved: boolean;
  remote: boolean;
  reason?: string;
  /** id of the graph node this reference points at. */
  targetNodeId: string;
  /** absolute file to open (or directory to reveal); null if not navigable. */
  openPath: string | null;
  openIsDir: boolean;
  /** For a remote module source: a browsable docs/repo URL. */
  docUrl?: string;
  /** whether the resolved target exists on disk. */
  exists: boolean;
  /** workspace-relative label of the target (for tree leaves). */
  targetLabel: string;
}

/** A scanned Terragrunt config file and its outgoing references. */
export interface Unit {
  /** absolute path to the config file (terragrunt.hcl / *.hcl). */
  configFile: string;
  dir: string;
  /** workspace-relative label. */
  label: string;
  references: ResolvedReference[];
  parseError?: string;
}

export interface GraphModel {
  units: Unit[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}
