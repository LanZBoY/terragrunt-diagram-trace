// Ambient declarations for modules without bundled types + the webview VS Code API global.

// cytoscape-dagre ships no type definitions; it default-exports a Cytoscape extension
// registrar consumed via `cytoscape.use(dagre)`.
declare module 'cytoscape-dagre' {
  const ext: unknown;
  export = ext;
}

// Available inside the webview only. Must be called exactly once per webview load.
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
};
