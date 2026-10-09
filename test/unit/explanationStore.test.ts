import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../fixtures/explanation.json';
import { ExplanationStore, repoStoreDir } from '../../src/core/explanationStore';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';
import type { StoredExplanation } from '../../src/core/types';

const stored = (sha: string): StoredExplanation => ({
  sha, promptVersion: PROMPT_VERSION, generatedAt: '2026-10-08T15:10:00Z', explainerSessionId: 'sess-1',
  inferred: false, explanation: fixture as unknown as Explanation, thread: [],
});

describe('ExplanationStore', () => {
  it('round-trips, lists shas, and ignores other prompt versions and corrupt files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-store-'));
    const store = new ExplanationStore(dir);
    expect(await store.get('aaa')).toBeUndefined();
    await store.put(stored('aaa'));
    expect((await store.get('aaa'))?.explainerSessionId).toBe('sess-1');
    await store.put({ ...stored('bbb'), promptVersion: PROMPT_VERSION + 1 });
    expect(await store.get('bbb')).toBeUndefined();
    writeFileSync(join(dir, 'ccc.json'), '{not json');
    expect(await store.get('ccc')).toBeUndefined();
    expect([...(await store.listCachedShas())]).toEqual(['aaa']);
  });

  it('derives a stable per-repo directory', () => {
    expect(repoStoreDir('/g', 'C:\\Repo\\App')).toBe(repoStoreDir('/g', 'c:/repo/app'));
    expect(repoStoreDir('/g', '/a')).not.toBe(repoStoreDir('/g', '/b'));
  });
});

describe('ExplanationStore.update', () => {
  it('applies concurrent read-modify-write updates without losing any', async () => {
    const store = new ExplanationStore(mkdtempSync(join(tmpdir(), 'ed-store-u-')));
    await store.put(stored('aaa'));
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      store.update('aaa', async (s) => {
        await new Promise((r) => setTimeout(r, 5));
        s.thread.push({ question: `Q${i}`, answer: 'A', askedAt: 't', filesChecked: [] });
      }),
    ));
    expect((await store.get('aaa'))!.thread).toHaveLength(10);
  });
  it('survives concurrent puts of the same commit', async () => {
    const store = new ExplanationStore(mkdtempSync(join(tmpdir(), 'ed-store-p-')));
    await Promise.all(Array.from({ length: 8 }, () => store.put(stored('aaa'))));
    expect(await store.get('aaa')).toBeDefined();
  });
});

describe('legacy caches', () => {
  it('reads claudeSessionId from caches written before the rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-store-legacy-'));
    const legacy = { ...stored('old'), claudeSessionId: 'sess-legacy' } as Record<string, unknown>;
    delete legacy.explainerSessionId;
    writeFileSync(join(dir, 'old.json'), JSON.stringify(legacy));
    expect((await new ExplanationStore(dir).get('old'))?.explainerSessionId).toBe('sess-legacy');
  });
});
