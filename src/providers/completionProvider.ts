// Completion inside *.hcl files, driven by the text just left of the cursor:
//   dependency.<name>.outputs.<…>  → that dependency's module outputs ∪ its mock_outputs keys
//   dependency.<…>                 → dependency labels declared in this file
//   local.<name>.locals.<…>        → keys of the config read via read_terragrunt_config in local.<name>
//   local.<…>                      → this file's locals keys
// All static: names come from module `output`/`variable` declarations and mock_outputs — never state.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseTerragrunt } from '../core/parser';
import { resolveReadConfig, type ResolveCtx } from '../core/resolve';
import { introspectModule, dependencyModuleDir } from '../core/moduleIntrospect';
import type { GraphModel } from '../core/model';
import { classifyCompletion } from '../core/completionContext';

function rootConfigName(): string {
  return vscode.workspace.getConfiguration('terragruntTrace').get<string>('rootConfigName', 'terragrunt.hcl');
}

/** Keys of the config that `local.<name> = read_terragrunt_config(<file>)` points at. */
async function readChainLocalKeys(file: string, localValue: unknown, rcn: string): Promise<string[]> {
  if (typeof localValue !== 'string') {
    return [];
  }
  const m = localValue.match(/^\$\{\s*read_terragrunt_config\((.+)\)\s*\}$/);
  if (!m) {
    return [];
  }
  const argRaw = m[1].trim();
  const readRaw = argRaw.startsWith('"') ? argRaw.slice(1, -1) : `\${${argRaw}}`;
  const dir = path.dirname(file);
  const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ?? dir;
  const ctx: ResolveCtx = { currentFile: file, currentDir: dir, workspaceRoot: ws, rootConfigName: rcn, localsMap: {} };
  const res = resolveReadConfig(readRaw, ctx);
  if (!res.resolved || !res.targetFile) {
    return [];
  }
  try {
    const text = await fs.promises.readFile(res.targetFile, 'utf8');
    return Object.keys((await parseTerragrunt(res.targetFile, text)).localsMap);
  } catch {
    return [];
  }
}

const items = (labels: Iterable<string>, kind: vscode.CompletionItemKind): vscode.CompletionItem[] =>
  [...labels].map((l) => new vscode.CompletionItem(l, kind));

// Re-open the suggestion list after an insert so e.g. picking `waf` → `waf.outputs.` flows
// straight into choosing an output.
const RETRIGGER: vscode.Command = { command: 'editor.action.triggerSuggest', title: '' };

export class TerragruntCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly getModel: () => GraphModel) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const ctx = classifyCompletion(linePrefix);
    if (!ctx) {
      return undefined;
    }

    const file = document.uri.fsPath;
    const rcn = rootConfigName();
    const parsed = await parseTerragrunt(file, document.getText());

    switch (ctx.kind) {
      case 'outputs': {
        const out = new Set<string>(parsed.mockOutputs[ctx.dep] ?? []);
        const dir = dependencyModuleDir(this.getModel(), file, ctx.dep);
        if (dir) {
          for (const o of (await introspectModule(dir)).outputs) {
            out.add(o);
          }
        }
        return items(out, vscode.CompletionItemKind.Field);
      }
      case 'readLocals':
        return items(await readChainLocalKeys(file, parsed.localsMap[ctx.local], rcn), vscode.CompletionItemKind.Variable);
      case 'dependencyAttr': {
        // A dependency reference is followed by `outputs` essentially always.
        const it = new vscode.CompletionItem('outputs', vscode.CompletionItemKind.Field);
        it.insertText = 'outputs.';
        it.command = RETRIGGER;
        return [it];
      }
      case 'dependencyName': {
        const names = new Set(parsed.refs.filter((r) => r.kind === 'dependency' && r.name).map((r) => r.name!));
        return [...names].map((n) => {
          const it = new vscode.CompletionItem(n, vscode.CompletionItemKind.Module);
          it.insertText = `${n}.outputs.`; // dependency refs are virtually always .outputs.<field>
          it.command = RETRIGGER;
          return it;
        });
      }
      case 'localKey':
        return items(Object.keys(parsed.localsMap), vscode.CompletionItemKind.Variable);
    }
  }
}
