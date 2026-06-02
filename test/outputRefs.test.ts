import { describe, it, expect } from 'vitest';
import { scanOutputRefs } from '../src/core/outputRefs';

describe('scanOutputRefs', () => {
  it('finds a dependency.<name>.outputs.<field> with the field offset', () => {
    const text = 'inputs = {\n  vpc_id = dependency.vpc.outputs.vpc_id\n}';
    const refs = scanOutputRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].dep).toBe('vpc');
    expect(refs[0].field).toBe('vpc_id');
    // fieldIndex must point exactly at the field token.
    expect(text.slice(refs[0].fieldIndex, refs[0].fieldIndex + refs[0].field.length)).toBe('vpc_id');
  });

  it('finds multiple refs in order', () => {
    const text = 'a = dependency.eks.outputs.cluster_name\nb = dependency.rds.outputs.endpoint';
    expect(scanOutputRefs(text).map((r) => `${r.dep}.${r.field}`)).toEqual([
      'eks.cluster_name',
      'rds.endpoint',
    ]);
  });

  it('returns empty when there are no output references', () => {
    expect(scanOutputRefs('terraform { source = "../x" }')).toEqual([]);
  });
});
