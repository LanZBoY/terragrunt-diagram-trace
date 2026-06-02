// Manages the single Cytoscape graph webview panel and its messaging.
import * as vscode from 'vscode';
import { ALL_EDGE_TYPES, type GraphPayload, type OutboundMessage } from '../shared/graph';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export interface GraphPanelHandlers {
  openNode(id: string): void;
  nodeSelected(id: string): void;
}

export class GraphPanel {
  static current: GraphPanel | undefined;
  private static readonly viewType = 'terragruntTrace.graph';

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingReveal: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private payload: GraphPayload,
    private readonly handlers: GraphPanelHandlers,
  ) {
    this.panel.webview.html = this.html();

    this.panel.webview.onDidReceiveMessage(
      (msg: OutboundMessage) => {
        switch (msg.type) {
          case 'ready':
            this.ready = true;
            this.postGraph();
            if (this.pendingReveal) {
              void this.panel.webview.postMessage({ type: 'reveal', id: this.pendingReveal });
              this.pendingReveal = undefined;
            }
            break;
          case 'openNode':
            this.handlers.openNode(msg.id);
            break;
          case 'nodeSelected':
            this.handlers.nodeSelected(msg.id);
            break;
        }
      },
      null,
      this.disposables,
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static show(
    extensionUri: vscode.Uri,
    payload: GraphPayload,
    handlers: GraphPanelHandlers,
  ): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.payload = payload;
      GraphPanel.current.handlers.openNode = handlers.openNode;
      GraphPanel.current.handlers.nodeSelected = handlers.nodeSelected;
      GraphPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      GraphPanel.current.postGraph();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      GraphPanel.viewType,
      'Terragrunt Graph',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri, payload, handlers);
    return GraphPanel.current;
  }

  update(payload: GraphPayload): void {
    this.payload = payload;
    this.postGraph();
  }

  reveal(id: string): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
    if (!this.ready) {
      this.pendingReveal = id; // flushed after the graph on the 'ready' handshake
      return;
    }
    void this.panel.webview.postMessage({ type: 'reveal', id });
  }

  postTheme(): void {
    void this.panel.webview.postMessage({ type: 'theme' });
  }

  private postGraph(): void {
    if (!this.ready) {
      return; // flushed on the webview 'ready' handshake
    }
    void this.panel.webview.postMessage({ type: 'graph', ...this.payload });
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'graph.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'graph.css'));

    const checkboxes = ALL_EDGE_TYPES.map(
      (t) =>
        `<label class="filter"><input type="checkbox" data-edge-type="${t}" checked /> <span class="swatch ${t}"></span>${t}</label>`,
    ).join('');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    img-src ${webview.cspSource} https: data:;
    style-src ${webview.cspSource} 'unsafe-inline';
    font-src ${webview.cspSource};
    script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Terragrunt Graph</title>
</head>
<body>
  <div id="toolbar">
    <div id="filters">${checkboxes}</div>
    <span id="hint">tap = focus · double-tap = open file</span>
    <div id="actions">
      <label class="focus-ctl">Focus
        <select id="focus-depth" title="How many hops around the tapped node to show">
          <option value="1" selected>neighbors</option>
          <option value="2">2 hops</option>
          <option value="0">all linked</option>
        </select>
      </label>
      <button id="btn-showall" title="Clear focus and show the whole graph">Show all</button>
      <button id="btn-fit">Fit</button>
      <button id="btn-relayout">Re-layout</button>
    </div>
  </div>
  <div id="cy"></div>
  <div id="tooltip" role="tooltip"></div>
  <div id="empty">No Terragrunt references found in this workspace.</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    GraphPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
