// Hover preview over a reference in a *.hcl file: the target's path, and for a dependency/include
// the target unit's source + dependency count + the module's declared outputs.
import * as vscode from 'vscode';
import * as path from 'path';
import { findReferenceTokens } from './navProvider';
import { introspectModule, unitModuleDir } from '../core/moduleIntrospect';
import type { GraphModel } from '../core/model';
import type { RefKind } from '../shared/graph';

const KIND_LABEL: Record<RefKind, string> = {
  dependency: 'dependency',
  dependencies: 'run-order dependency',
  include: 'include',
  source: 'module source',
  read: 'read config',
};

function rootConfigName(): string {
  return vscode.workspace.getConfiguration('terragruntTrace').get<string>('rootConfigName', 'terragrunt.hcl');
}

const list = (items: string[]): string => items.map((i) => `\`${i}\``).join(', ');

export class TerragruntHoverProvider implements vscode.HoverProvider {
  constructor(private readonly getModel: () => GraphModel) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    const tokens = await findReferenceTokens(document, rootConfigName());
    const hit = tokens.find((t) => t.range.contains(position));
    if (!hit) {
      return undefined;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = false;

    if (hit.target.scheme === 'http' || hit.target.scheme === 'https') {
      md.appendMarkdown(`**Terragrunt ${KIND_LABEL[hit.kind]}** → [open docs](${hit.target.toString()})`);
      return new vscode.Hover(md, hit.range);
    }

    const model = this.getModel();
    const targetPath = hit.target.fsPath;
    const rel = vscode.workspace.asRelativePath(hit.target);
    md.appendMarkdown(`**Terragrunt ${KIND_LABEL[hit.kind]}** → \`${rel}\``);

    // dependency / dependencies / include / read → a config file. If it's a scanned unit,
    // summarize it and show the module's outputs.
    const targetUnit = model.units.find((u) => u.configFile === targetPath);
    if (targetUnit) {
      const src = targetUnit.references.find((r) => r.kind === 'source');
      const depCount = targetUnit.references.filter((r) => r.kind === 'dependency').length;
      md.appendMarkdown(`\n\nsource: \`${src?.rawValue ?? '—'}\` · ${depCount} dependenc${depCount === 1 ? 'y' : 'ies'}`);
      const moduleDir = unitModuleDir(model, targetPath);
      if (moduleDir) {
        const { outputs } = await introspectModule(moduleDir);
        if (outputs.length) {
          md.appendMarkdown(`\n\n**Outputs:** ${list(outputs)}`);
        }
      }
    }

    // source token → show the module's own interface (outputs it exposes, variables it expects).
    if (hit.kind === 'source') {
      const moduleDir = targetPath.endsWith('.tf') ? path.dirname(targetPath) : targetPath;
      const { outputs, variables } = await introspectModule(moduleDir);
      if (outputs.length) {
        md.appendMarkdown(`\n\n**Outputs:** ${list(outputs)}`);
      }
      if (variables.length) {
        md.appendMarkdown(`\n\n**Variables:** ${list(variables)}`);
      }
    }

    return new vscode.Hover(md, hit.range);
  }
}
