// Locate `dependency.<name>.outputs.<field>` references in raw .hcl text, for the
// "unknown output" diagnostic. Pure + offset-based so it is unit-tested without vscode.

export interface OutputRef {
  dep: string;
  field: string;
  /** Char offset of <field> within the text (convert to an editor range with positionAt). */
  fieldIndex: number;
}

export function scanOutputRefs(text: string): OutputRef[] {
  const re = /\bdependency\.(\w+)\.outputs\.(\w+)/g;
  const out: OutputRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const field = m[2];
    out.push({ dep: m[1], field, fieldIndex: m.index + m[0].length - field.length });
  }
  return out;
}
