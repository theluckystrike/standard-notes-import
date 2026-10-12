import { describe, expect, it } from 'vitest';
import vectors from './vectors/standard-notes-import.json';
import { planImport, type Existing, type Rule } from '../src/importer';

describe('golden acceptance vectors', () => {
 for (const c of vectors.cases) it(c.name, () => {
  const a = c.args as unknown[];
  expect(planImport(a[0], a[1] as string | undefined, a[2] as Existing[] | undefined, a[3] as string[] | undefined, a[4] as Rule[] | undefined, a[5] as boolean | undefined)).toEqual(c.expected);
 });
});
