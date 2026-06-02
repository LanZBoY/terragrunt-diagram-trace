import { describe, it, expect } from 'vitest';
import { classifyCompletion } from '../src/core/completionContext';

describe('classifyCompletion', () => {
  it('detects dependency.<name>.outputs.<partial>', () => {
    expect(classifyCompletion('  cluster = dependency.eks.outputs.')).toEqual({ kind: 'outputs', dep: 'eks' });
    expect(classifyCompletion('  x = dependency.rds.outputs.endp')).toEqual({ kind: 'outputs', dep: 'rds' });
  });

  it('detects local.<name>.locals.<partial>', () => {
    expect(classifyCompletion('  source = local.account.locals.')).toEqual({ kind: 'readLocals', local: 'account' });
  });

  it('detects a bare dependency.<partial>', () => {
    expect(classifyCompletion('  x = dependency.')).toEqual({ kind: 'dependencyName' });
    expect(classifyCompletion('  x = dependency.ek')).toEqual({ kind: 'dependencyName' });
  });

  it('detects dependency.<name>.<partial> as dependencyAttr (→ outputs)', () => {
    expect(classifyCompletion('  x = dependency.waf.')).toEqual({ kind: 'dependencyAttr', dep: 'waf' });
    expect(classifyCompletion('  x = dependency.waf.out')).toEqual({ kind: 'dependencyAttr', dep: 'waf' });
    // .outputs. (trailing dot) is the deeper field context, not dependencyAttr.
    expect(classifyCompletion('  x = dependency.waf.outputs.')).toEqual({ kind: 'outputs', dep: 'waf' });
  });

  it('detects a bare local.<partial>', () => {
    expect(classifyCompletion('  region = local.')).toEqual({ kind: 'localKey' });
    expect(classifyCompletion('  region = local.aws_re')).toEqual({ kind: 'localKey' });
  });

  it('prefers outputs over the bare dependency match', () => {
    // The deeper .outputs. context must win, not be swallowed by dependency.<partial>.
    expect(classifyCompletion('dependency.eks.outputs.')).toEqual({ kind: 'outputs', dep: 'eks' });
  });

  it('returns null when the cursor is not in a completion context', () => {
    expect(classifyCompletion('terraform {')).toBeNull();
    expect(classifyCompletion('  source = "../modules/x"')).toBeNull();
    expect(classifyCompletion('')).toBeNull();
  });
});
