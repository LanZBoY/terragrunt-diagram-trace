// Activity Bar tree: units → relationship groups → reference leaves.
import * as vscode from 'vscode';
import type { RefKind } from '../shared/graph';
import type { GraphModel, ResolvedReference, Unit } from '../core/model';

interface UnitNode {
  type: 'unit';
  unit: Unit;
  groups: GroupNode[];
}
interface GroupNode {
  type: 'group';
  kind: RefKind;
  label: string;
  leaves: LeafNode[];
  parent: UnitNode;
}
interface LeafNode {
  type: 'leaf';
  ref: ResolvedReference;
  index: number;
  parent: GroupNode;
}
export type TreeNode = UnitNode | GroupNode | LeafNode;

const GROUP_ORDER: { kind: RefKind; label: string; icon: string }[] = [
  { kind: 'dependency', label: 'Dependencies', icon: 'references' },
  { kind: 'dependencies', label: 'Run-order', icon: 'list-ordered' },
  { kind: 'include', label: 'Includes', icon: 'file-symlink-file' },
  { kind: 'source', label: 'Source', icon: 'file-code' },
];

export class TerragruntTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private roots: UnitNode[] = [];
  private byConfigFile = new Map<string, UnitNode>();

  dispose(): void {
    this._onDidChange.dispose();
  }

  setModel(model: GraphModel): void {
    this.roots = [];
    this.byConfigFile.clear();
    for (const unit of model.units) {
      const unitNode: UnitNode = { type: 'unit', unit, groups: [] };
      for (const g of GROUP_ORDER) {
        const refs = unit.references.filter((r) => r.kind === g.kind);
        if (refs.length === 0) {
          continue;
        }
        const group: GroupNode = { type: 'group', kind: g.kind, label: g.label, leaves: [], parent: unitNode };
        group.leaves = refs.map((ref, index) => ({ type: 'leaf', ref, index, parent: group }));
        unitNode.groups.push(group);
      }
      this.roots.push(unitNode);
      this.byConfigFile.set(unit.configFile, unitNode);
    }
    this._onDidChange.fire();
  }

  unitNodeFor(configFile: string): UnitNode | undefined {
    return this.byConfigFile.get(configFile);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.roots;
    }
    if (element.type === 'unit') {
      return element.groups;
    }
    if (element.type === 'group') {
      return element.leaves;
    }
    return [];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    if (element.type === 'leaf') {
      return element.parent;
    }
    if (element.type === 'group') {
      return element.parent;
    }
    return undefined;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.type === 'unit') {
      const hasChildren = element.groups.length > 0;
      const item = new vscode.TreeItem(
        element.unit.label,
        hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `unit:${element.unit.configFile}`;
      item.iconPath = new vscode.ThemeIcon(element.unit.parseError ? 'warning' : 'package');
      item.resourceUri = vscode.Uri.file(element.unit.configFile);
      item.tooltip = element.unit.parseError
        ? `Parse error: ${element.unit.parseError}`
        : element.unit.configFile;
      item.contextValue = 'terragruntUnit';
      const refCount = element.unit.references.length;
      item.description = element.unit.parseError
        ? 'parse error'
        : `${refCount} ref${refCount === 1 ? '' : 's'}`;
      if (!hasChildren) {
        // Errored / refless unit: clicking opens the file so the user can fix it.
        item.command = {
          command: 'vscode.open',
          title: 'Open',
          arguments: [vscode.Uri.file(element.unit.configFile)],
        };
      }
      return item;
    }

    if (element.type === 'group') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `group:${element.parent.unit.configFile}:${element.kind}`;
      const meta = GROUP_ORDER.find((g) => g.kind === element.kind)!;
      item.iconPath = new vscode.ThemeIcon(meta.icon);
      item.description = String(element.leaves.length);
      return item;
    }

    const ref = element.ref;
    const item = new vscode.TreeItem(ref.targetLabel, vscode.TreeItemCollapsibleState.None);
    item.id = `leaf:${element.parent.parent.unit.configFile}:${element.parent.kind}:${element.index}`;
    const name = ref.name ? `"${ref.name}" ` : '';
    item.description = `${name}${ref.rawValue}`;

    if (ref.remote) {
      if (ref.docUrl) {
        item.iconPath = new vscode.ThemeIcon('link-external');
        item.tooltip = `Open module docs in browser:\n${ref.docUrl}`;
        item.command = { command: 'terragruntTrace.openUrl', title: 'Open docs', arguments: [ref.docUrl] };
      } else {
        item.iconPath = new vscode.ThemeIcon('cloud');
        item.tooltip = `Remote source (not navigable)\n${ref.rawValue}`;
      }
    } else if (!ref.resolved) {
      item.iconPath = new vscode.ThemeIcon('question');
      item.tooltip = `Unresolved (${ref.reason ?? 'dynamic'})\n${ref.rawValue}`;
    } else if (ref.openPath) {
      item.iconPath = new vscode.ThemeIcon(ref.openIsDir ? 'folder' : 'arrow-right');
      item.resourceUri = vscode.Uri.file(ref.openPath);
      item.tooltip = `${ref.openPath}${ref.exists ? '' : '  (not found on disk)'}`;
      item.command = {
        command: 'terragruntTrace.openFileAt',
        title: 'Open',
        arguments: [ref.openPath, ref.openIsDir],
      };
    }
    return item;
  }
}
