import { describe, it, expect } from 'vitest';
import { planDiffTabs } from '../../src/core/tabPlan';
import type { ChangedFile } from '../../src/core/types';

const f = (status: ChangedFile['status'], path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ status, path, added: 1, removed: 1, binary: false, ...extra });

describe('planDiffTabs', () => {
  const sha = 'a1c9e42fff';
  it('maps statuses to left/right refs and titles', () => {
    const { tabs } = planDiffTabs(sha, 'a1c9e42', [
      f('M', 'src/webhooks/handler.ts'),
      f('A', 'db/0042.sql'),
      f('D', 'old.ts'),
      f('R', 'src/new.ts', { oldPath: 'src/old.ts' }),
    ], 20);
    expect(tabs).toEqual([
      { path: 'src/webhooks/handler.ts', leftRef: `${sha}^`, leftPath: 'src/webhooks/handler.ts', rightRef: sha, rightPath: 'src/webhooks/handler.ts', title: 'handler.ts · M · a1c9e42' },
      { path: 'db/0042.sql', leftRef: null, leftPath: 'db/0042.sql', rightRef: sha, rightPath: 'db/0042.sql', title: '0042.sql · A · a1c9e42' },
      { path: 'old.ts', leftRef: `${sha}^`, leftPath: 'old.ts', rightRef: null, rightPath: 'old.ts', title: 'old.ts · D · a1c9e42' },
      { path: 'src/new.ts', leftRef: `${sha}^`, leftPath: 'src/old.ts', rightRef: sha, rightPath: 'src/new.ts', title: 'new.ts · R · a1c9e42' },
    ]);
  });

  it('skips binary files and caps the number of tabs', () => {
    const files = [f('A', 'logo.png', { binary: true, added: null, removed: null }), ...Array.from({ length: 5 }, (_, i) => f('M', `f${i}.ts`))];
    const r = planDiffTabs(sha, 'a1c9e42', files, 3);
    expect(r.tabs.map((t) => t.path)).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(r.overflow).toBe(2);
    expect(r.binary).toEqual(['logo.png']);
  });
});
