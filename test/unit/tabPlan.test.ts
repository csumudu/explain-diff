import { describe, it, expect } from 'vitest';
import { diffTabFor } from '../../src/core/tabPlan';
import type { ChangedFile } from '../../src/core/types';

const f = (status: ChangedFile['status'], path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ status, path, added: 1, removed: 1, binary: false, ...extra });

describe('diffTabFor', () => {
  const sha = 'a1c9e42fff';
  it('maps statuses to left/right refs and titles', () => {
    const tabs = [
      f('M', 'src/webhooks/handler.ts'),
      f('A', 'db/0042.sql'),
      f('D', 'old.ts'),
      f('R', 'src/new.ts', { oldPath: 'src/old.ts' }),
    ].map((x) => diffTabFor(sha, 'a1c9e42', x));
    expect(tabs).toEqual([
      { path: 'src/webhooks/handler.ts', leftRef: `${sha}^`, leftPath: 'src/webhooks/handler.ts', rightRef: sha, rightPath: 'src/webhooks/handler.ts', title: 'handler.ts · M · a1c9e42' },
      { path: 'db/0042.sql', leftRef: null, leftPath: 'db/0042.sql', rightRef: sha, rightPath: 'db/0042.sql', title: '0042.sql · A · a1c9e42' },
      { path: 'old.ts', leftRef: `${sha}^`, leftPath: 'old.ts', rightRef: null, rightPath: 'old.ts', title: 'old.ts · D · a1c9e42' },
      { path: 'src/new.ts', leftRef: `${sha}^`, leftPath: 'src/old.ts', rightRef: sha, rightPath: 'src/new.ts', title: 'new.ts · R · a1c9e42' },
    ]);
  });
});
