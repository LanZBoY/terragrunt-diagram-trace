// Webview entry: renders the Terragrunt reference graph with Cytoscape + dagre.
// Bundled by esbuild (platform:browser, iife) into media/graph.js. CSP-safe: no inline
// scripts, no eval, all listeners attached via addEventListener.
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import type { EdgeType, GraphNode, GraphEdge, InboundMessage } from '../src/shared/graph';

cytoscape.use(dagre as cytoscape.Ext);

const vscodeApi = acquireVsCodeApi();
let cy: cytoscape.Core | undefined;
const pending: InboundMessage[] = [];
const activeTypes = new Set<EdgeType>(['dependency', 'dependencies', 'include', 'source', 'read']);

// Focus mode: when set, only the focused node's neighborhood (within focusDepth hops) is shown.
let focusedId: string | null = null;
let focusDepth = 1; // 1 = direct neighbors, 2 = two hops, 0 = whole connected component

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function theme() {
  return {
    fg: cssVar('--vscode-editor-foreground', '#cccccc'),
    nodeBg: cssVar('--vscode-editor-inactiveSelectionBackground', '#2a2d2e'),
    configBg: cssVar('--vscode-editorWidget-background', '#252526'),
    border: cssVar('--vscode-panel-border', '#555555'),
    blue: cssVar('--vscode-charts-blue', '#3794ff'),
    gray: cssVar('--vscode-descriptionForeground', '#9d9d9d'),
    purple: cssVar('--vscode-charts-purple', '#b180d7'),
    green: cssVar('--vscode-charts-green', '#89d185'),
    red: cssVar('--vscode-charts-red', '#f14c4c'),
    yellow: cssVar('--vscode-charts-yellow', '#cca700'),
  };
}

function buildStyle(t: ReturnType<typeof theme>): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: 'node',
      style: {
        'background-color': t.nodeBg,
        'border-width': 1,
        'border-color': t.border,
        label: 'data(label)',
        color: t.fg,
        'font-size': 11,
        'min-zoomed-font-size': 7,
        'text-wrap': 'ellipsis', // never let a long label distort the layout
        'text-max-width': '170px',
        shape: 'round-rectangle',
        width: 'label',
        height: 'label',
        padding: '6px',
        'text-valign': 'center',
        'text-halign': 'center',
      },
    },
    { selector: 'node[kind="config"]', style: { 'background-color': t.configBg, shape: 'round-rectangle', 'border-style': 'solid' } },
    { selector: 'node[kind="module"]', style: { shape: 'round-tag', 'border-color': t.green } },
    { selector: 'node[kind="external"]', style: { 'border-style': 'dashed', 'border-color': t.gray, color: t.gray, opacity: 0.8, shape: 'round-diamond' } },
    { selector: 'node.focal', style: { 'border-width': 3, 'border-color': t.yellow } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        width: 1.5,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'font-size': 9,
      },
    },
    { selector: 'edge[type="dependency"]', style: { 'line-color': t.blue, 'target-arrow-color': t.blue, 'line-style': 'solid' } },
    { selector: 'edge[type="dependencies"]', style: { 'line-color': t.gray, 'target-arrow-color': t.gray, 'line-style': 'dashed' } },
    { selector: 'edge[type="include"]', style: { 'line-color': t.purple, 'target-arrow-color': t.purple, 'line-style': 'dotted' } },
    { selector: 'edge[type="source"]', style: { 'line-color': t.green, 'target-arrow-color': t.green, 'line-style': 'solid', 'target-arrow-shape': 'vee' } },
    { selector: 'edge[type="read"]', style: { 'line-color': t.yellow, 'target-arrow-color': t.yellow, 'line-style': 'dashed' } },
    { selector: 'edge[resolved=0]', style: { 'line-color': t.red, 'target-arrow-color': t.red, 'line-style': 'dashed', opacity: 0.5 } },
    { selector: '.highlighted', style: { 'border-width': 4, 'border-color': t.yellow, 'z-index': 999 } },
  ];
}

function layoutOptions(n: number): cytoscape.LayoutOptions {
  if (n > 600) {
    return { name: 'breadthfirst', directed: true, padding: 30, fit: true } as cytoscape.LayoutOptions;
  }
  return {
    name: 'dagre',
    rankDir: 'TB',
    nodeSep: 40,
    rankSep: 70,
    edgeSep: 10,
    animate: n < 150,
    fit: true,
    padding: 30,
    stop: () => cy?.fit(cy.elements(':visible'), 30),
  } as unknown as cytoscape.LayoutOptions;
}

function hideTooltip(): void {
  const tip = document.getElementById('tooltip');
  if (tip) {
    tip.style.display = 'none';
  }
}

function setEmpty(visible: boolean): void {
  const el = document.getElementById('empty');
  if (el) {
    el.style.display = visible ? 'flex' : 'none';
  }
}

/** Node ids to show given the current focus; null means "show everything". */
function visibleNodeIds(): Set<string> | null {
  if (!cy || !focusedId) {
    return null;
  }
  const focal = cy.$id(focusedId);
  if (focal.empty()) {
    return null; // focused node no longer exists (e.g. after a rescan)
  }
  const seen = new Set<string>([focusedId]);
  let frontier: cytoscape.CollectionReturnValue = focal;
  const maxDepth = focusDepth > 0 ? focusDepth : Number.POSITIVE_INFINITY;
  for (let i = 0; i < maxDepth; i++) {
    const next = frontier.openNeighborhood().nodes().filter((nd) => !seen.has(nd.id()));
    if (next.empty()) {
      break;
    }
    next.forEach((nd) => {
      seen.add(nd.id());
    });
    frontier = next;
  }
  return seen;
}

/** Apply edge-type filter + focus neighborhood to element visibility (no layout). */
function applyVisibility(): void {
  if (!cy) {
    return;
  }
  const vis = visibleNodeIds();
  cy.batch(() => {
    cy!.nodes().forEach((n) => {
      n.style('display', !vis || vis.has(n.id()) ? 'element' : 'none');
      if (focusedId && n.id() === focusedId) {
        n.addClass('focal');
      } else {
        n.removeClass('focal');
      }
    });
    cy!.edges().forEach((ed) => {
      const ok =
        activeTypes.has(ed.data('type') as EdgeType) &&
        (!vis || (vis.has(ed.source().id()) && vis.has(ed.target().id())));
      ed.style('display', ok ? 'element' : 'none');
    });
  });
}

function relayoutVisible(): void {
  if (!cy) {
    return;
  }
  const eles = cy.elements(':visible');
  eles.layout(layoutOptions(eles.nodes().length)).run();
}

function setFocus(id: string | null): void {
  focusedId = id;
  hideTooltip();
  applyVisibility();
  relayoutVisible();
}

function handleMessage(msg: InboundMessage): void {
  if (!cy) {
    pending.push(msg);
    return;
  }
  switch (msg.type) {
    case 'graph': {
      hideTooltip();
      const ids = new Set<string>(msg.nodes.map((n: GraphNode) => n.id));
      const els: cytoscape.ElementDefinition[] = [
        ...msg.nodes.map((n: GraphNode) => ({ data: { id: n.id, label: n.label, title: n.title, kind: n.kind } })),
        ...msg.edges
          .filter((e: GraphEdge) => ids.has(e.source) && ids.has(e.target))
          .map((e: GraphEdge) => ({
            data: {
              id: `${e.source}->${e.target}:${e.type}`,
              source: e.source,
              target: e.target,
              type: e.type,
              resolved: e.resolved ? 1 : 0,
            },
          })),
      ];
      cy.batch(() => {
        cy!.elements().remove();
        cy!.add(els);
      });
      if (focusedId && cy.$id(focusedId).empty()) {
        focusedId = null; // focal node gone after rescan
      }
      applyVisibility();
      relayoutVisible();
      setEmpty(msg.nodes.length === 0);
      break;
    }
    case 'reveal': {
      const n = cy.$id(msg.id);
      if (n.nonempty()) {
        setFocus(msg.id); // focusing also frames the node's neighborhood
        n.addClass('highlighted');
        setTimeout(() => n.removeClass('highlighted'), 2000);
      }
      break;
    }
    case 'theme':
      cy.style().fromJson(buildStyle(theme())).update();
      break;
  }
}

function wireInteractions(core: cytoscape.Core): void {
  // Single tap focuses the node's neighborhood + syncs the tree; double tap opens the file.
  core.on('tap', 'node', (e) => {
    const id = e.target.id();
    setFocus(id);
    vscodeApi.postMessage({ type: 'nodeSelected', id });
  });
  core.on('dbltap', 'node', (e) => {
    vscodeApi.postMessage({ type: 'openNode', id: e.target.id() });
  });

  const tip = document.getElementById('tooltip');
  if (tip) {
    core.on('mouseover', 'node', (e) => {
      const d = e.target.data();
      tip.textContent = `${d.title ?? d.label}\n[${d.kind}]`;
      const rect = core.container()?.getBoundingClientRect();
      const p = e.renderedPosition ?? { x: 0, y: 0 };
      tip.style.left = `${(rect?.left ?? 0) + p.x + 12}px`;
      tip.style.top = `${(rect?.top ?? 0) + p.y + 12}px`;
      tip.style.display = 'block';
    });
    core.on('mouseout', 'node', () => (tip.style.display = 'none'));
    core.on('pan zoom', () => (tip.style.display = 'none'));
  }

  document.getElementById('btn-relayout')?.addEventListener('click', () => relayoutVisible());
  document.getElementById('btn-fit')?.addEventListener('click', () => core.fit(core.elements(':visible'), 30));
  document.getElementById('btn-showall')?.addEventListener('click', () => setFocus(null));

  const depthSel = document.getElementById('focus-depth') as HTMLSelectElement | null;
  depthSel?.addEventListener('change', () => {
    focusDepth = parseInt(depthSel.value, 10) || 0;
    if (focusedId) {
      applyVisibility();
      relayoutVisible();
    }
  });

  document.querySelectorAll<HTMLInputElement>('input[data-edge-type]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const t = cb.dataset.edgeType as EdgeType;
      if (cb.checked) {
        activeTypes.add(t);
      } else {
        activeTypes.delete(t);
      }
      applyVisibility(); // edge-type toggle keeps node positions (no relayout)
    });
  });

  window.addEventListener('resize', () => core.resize());
}

function observeTheme(): void {
  new MutationObserver(() => {
    cy?.style().fromJson(buildStyle(theme())).update();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

window.addEventListener('message', (e: MessageEvent<InboundMessage>) => handleMessage(e.data));

window.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('cy');
  if (!container) {
    return;
  }
  cy = cytoscape({
    container,
    elements: [],
    style: buildStyle(theme()),
    wheelSensitivity: 0.2,
    textureOnViewport: true,
    hideEdgesOnViewport: true,
    motionBlur: false,
  });
  wireInteractions(cy);
  observeTheme();
  vscodeApi.postMessage({ type: 'ready' });
  while (pending.length) {
    handleMessage(pending.shift()!);
  }
});
