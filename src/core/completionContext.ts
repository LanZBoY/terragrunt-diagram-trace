// Pure cursor-context classification for *.hcl completion. No `vscode` import so it stays
// unit-testable; the provider shell (providers/completionProvider.ts) supplies the data.

/** What the text just left of the cursor calls for. */
export type CompletionContext =
  | { kind: 'outputs'; dep: string }
  | { kind: 'readLocals'; local: string }
  | { kind: 'dependencyAttr'; dep: string }
  | { kind: 'dependencyName' }
  | { kind: 'localKey' }
  | null;

export function classifyCompletion(linePrefix: string): CompletionContext {
  let m = linePrefix.match(/dependency\.(\w+)\.outputs\.\w*$/);
  if (m) {
    return { kind: 'outputs', dep: m[1] };
  }
  m = linePrefix.match(/\blocal\.(\w+)\.locals\.\w*$/);
  if (m) {
    return { kind: 'readLocals', local: m[1] };
  }
  // dependency.<name>.<partial> — in a reference this is virtually always `.outputs`.
  m = linePrefix.match(/\bdependency\.(\w+)\.\w*$/);
  if (m) {
    return { kind: 'dependencyAttr', dep: m[1] };
  }
  if (/\bdependency\.\w*$/.test(linePrefix)) {
    return { kind: 'dependencyName' };
  }
  if (/\blocal\.\w*$/.test(linePrefix)) {
    return { kind: 'localKey' };
  }
  return null;
}
