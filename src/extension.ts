import * as vscode from 'vscode';
import { buildModel } from './core/scanner';
import { parseTerragrunt } from './core/parser';
import type { GraphModel } from './core/model';
import { TerragruntTreeProvider, type TreeNode } from './providers/treeProvider';
import { TerragruntLinkProvider, TerragruntDefinitionProvider } from './providers/navProvider';
import { TerragruntHoverProvider } from './providers/hoverProvider';
import { TerragruntCompletionProvider } from './providers/completionProvider';
import { clearModuleCache } from './core/moduleIntrospect';
import { GraphPanel } from './webview/panel';
import type { GraphPayload } from './shared/graph';

const HCL_SELECTOR: vscode.DocumentSelector = [{ scheme: 'file', pattern: '**/*.hcl' }];
const EMPTY_MODEL: GraphModel = { units: [], nodes: [], edges: [] };

let currentModel: GraphModel = EMPTY_MODEL;
let scanPromise: Promise<void> | null = null;
let diagnostics: vscode.DiagnosticCollection | undefined;

function config() {
  return vscode.workspace.getConfiguration('terragruntTrace');
}

function excludeGlob(): string | null {
  const patterns = config().get<string[]>('scan.exclude', []);
  if (patterns.length === 0) {
    return null;
  }
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
}

async function findHclFiles(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const exclude = excludeGlob();
  const files = new Set<string>();
  for (const folder of folders) {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.hcl'),
      exclude ?? undefined,
    );
    for (const uri of found) {
      files.add(uri.fsPath);
    }
  }
  return [...files];
}

async function rescan(tree: TerragruntTreeProvider): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = folders.map((f) => f.uri.fsPath);
  const rootConfigName = config().get<string>('rootConfigName', 'terragrunt.hcl');
  const files = await findHclFiles();
  currentModel = await buildModel(files, roots, { rootConfigName });
  clearModuleCache(); // module .tf may have changed since last scan; drop introspection cache
  tree.setModel(currentModel);
  publishDiagnostics();
  if (GraphPanel.current) {
    GraphPanel.current.update(payload());
  }
}

/** hcl2json error strings look like "<file>:<line>,<col>-<col>: summary; detail". Extract a range. */
function parseErrorRange(msg: string): vscode.Range {
  const m = msg.match(/:(\d+),(\d+)(?:-(\d+))?/);
  if (m) {
    const line = Math.max(0, parseInt(m[1], 10) - 1);
    const col = Math.max(0, parseInt(m[2], 10) - 1);
    const endCol = m[3] ? Math.max(col + 1, parseInt(m[3], 10) - 1) : col + 1;
    return new vscode.Range(line, col, line, endCol);
  }
  return new vscode.Range(0, 0, 0, 1);
}

function publishDiagnostics(): void {
  if (!diagnostics) {
    return;
  }
  diagnostics.clear();
  for (const unit of currentModel.units) {
    if (!unit.parseError) {
      continue;
    }
    diagnostics.set(vscode.Uri.file(unit.configFile), [
      new vscode.Diagnostic(
        parseErrorRange(unit.parseError),
        `Terragrunt parse error: ${unit.parseError}`,
        vscode.DiagnosticSeverity.Error,
      ),
    ]);
  }
}

const validateTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Re-parse a .hcl document's in-memory text and set/clear its syntax-error diagnostic live. */
async function validateDocument(doc: vscode.TextDocument): Promise<void> {
  if (!diagnostics || doc.uri.scheme !== 'file' || !doc.fileName.endsWith('.hcl')) {
    return;
  }
  const { error } = await parseTerragrunt(doc.uri.fsPath, doc.getText());
  if (error) {
    diagnostics.set(doc.uri, [
      new vscode.Diagnostic(
        parseErrorRange(error),
        `Terragrunt parse error: ${error}`,
        vscode.DiagnosticSeverity.Error,
      ),
    ]);
  } else {
    diagnostics.delete(doc.uri);
  }
}

/** Debounced per-document validation while typing (no need to save first). */
function scheduleValidate(doc: vscode.TextDocument): void {
  const key = doc.uri.toString();
  const existing = validateTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  validateTimers.set(
    key,
    setTimeout(() => {
      validateTimers.delete(key);
      void validateDocument(doc);
    }, 300),
  );
}

function payload(): GraphPayload {
  return { nodes: currentModel.nodes, edges: currentModel.edges };
}

async function openFileAt(pathOrUri: string | vscode.Uri, isDir?: boolean): Promise<void> {
  const uri = pathOrUri instanceof vscode.Uri ? pathOrUri : vscode.Uri.file(pathOrUri);
  if (isDir) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const tree = new TerragruntTreeProvider();
  const treeView = vscode.window.createTreeView('terragruntTrace.tree', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  diagnostics = vscode.languages.createDiagnosticCollection('terragruntTrace');

  const graphHandlers = {
    openNode: (id: string): void => {
      const node = currentModel.nodes.find((n) => n.id === id);
      if (!node) {
        return;
      }
      if (node.openUrl) {
        void vscode.env.openExternal(vscode.Uri.parse(node.openUrl)); // remote module → docs/repo
      } else if (node.openPath) {
        void openFileAt(node.openPath, node.openIsDir);
      } else {
        void vscode.window.showInformationMessage(`Not navigable: ${node.label}`);
      }
    },
    nodeSelected: (id: string): void => {
      const unitNode = tree.unitNodeFor(id);
      if (unitNode) {
        void treeView.reveal(unitNode, { select: true, focus: false, expand: true });
      }
    },
  };

  const ensureScanned = async (): Promise<void> => {
    if (!scanPromise) {
      scanPromise = rescan(tree);
    }
    await scanPromise;
  };

  context.subscriptions.push(
    treeView,
    tree,
    diagnostics,
    vscode.languages.registerDocumentLinkProvider(HCL_SELECTOR, new TerragruntLinkProvider()),
    vscode.languages.registerDefinitionProvider(HCL_SELECTOR, new TerragruntDefinitionProvider()),
    vscode.languages.registerHoverProvider(HCL_SELECTOR, new TerragruntHoverProvider(() => currentModel)),
    vscode.languages.registerCompletionItemProvider(
      HCL_SELECTOR,
      new TerragruntCompletionProvider(() => currentModel),
      '.',
    ),

    vscode.commands.registerCommand('terragruntTrace.openFileAt', openFileAt),

    vscode.commands.registerCommand('terragruntTrace.openUrl', (url: string) => {
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('terragruntTrace.rescan', async () => {
      scanPromise = rescan(tree);
      await scanPromise;
      void vscode.window.showInformationMessage(
        `Terragrunt: ${currentModel.units.length} units, ${currentModel.edges.length} references.`,
      );
    }),

    vscode.commands.registerCommand('terragruntTrace.showGraph', async () => {
      await ensureScanned();
      GraphPanel.show(context.extensionUri, payload(), graphHandlers);
    }),

    vscode.commands.registerCommand('terragruntTrace.revealInGraph', async (arg?: TreeNode | vscode.Uri) => {
      await ensureScanned();
      let id: string | undefined;
      if (arg && typeof arg === 'object' && 'type' in arg && arg.type === 'unit') {
        id = arg.unit.configFile;
      } else if (arg instanceof vscode.Uri) {
        id = arg.fsPath;
      } else {
        id = vscode.window.activeTextEditor?.document.uri.fsPath;
      }

      const hasNode = !!id && currentModel.nodes.some((n) => n.id === id);
      const hasEdges = !!id && currentModel.edges.some((e) => e.source === id || e.target === id);

      GraphPanel.show(context.extensionUri, payload(), graphHandlers);
      if (id && hasNode) {
        GraphPanel.current?.reveal(id); // focuses the node's neighborhood = its related modules
        if (!hasEdges) {
          void vscode.window.showInformationMessage(
            'Terragrunt: this file has no related modules (no references in or out).',
          );
        }
      } else {
        void vscode.window.showInformationMessage(
          'Terragrunt: this file is not part of the scanned Terragrunt project.',
        );
      }
    }),

    vscode.window.onDidChangeActiveColorTheme(() => GraphPanel.current?.postTheme()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scanPromise = rescan(tree);
    }),

    // Live syntax diagnostics while editing (in-memory text, before save).
    vscode.workspace.onDidChangeTextDocument((e) => scheduleValidate(e.document)),
    vscode.workspace.onDidOpenTextDocument((doc) => void validateDocument(doc)),
    { dispose: () => validateTimers.forEach((t) => clearTimeout(t)) },
  );

  if (vscode.window.activeTextEditor) {
    void validateDocument(vscode.window.activeTextEditor.document);
  }

  // Debounced file watcher.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.hcl');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      scanPromise = rescan(tree);
    }, 350);
  };
  watcher.onDidCreate(schedule);
  watcher.onDidChange(schedule);
  watcher.onDidDelete(schedule);
  context.subscriptions.push(watcher, { dispose: () => timer && clearTimeout(timer) });

  // Initial scan.
  void ensureScanned();
}

export function deactivate(): void {
  GraphPanel.current?.dispose();
}
