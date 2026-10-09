import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../fixtures/explanation.json';
import { ExplanationStore } from '../../src/core/explanationStore';
import { ExplainService, ExplanationInvalidError } from '../../src/core/explainService';
import type { RunOptions, RunResult } from '../../src/harnesses/types';

function setup(replies: string[]) {
  const calls: RunOptions[] = [];
  const runner = {
    run: vi.fn(async (o: RunOptions): Promise<RunResult> => {
      calls.push(o);
      o.onProgress?.({ type: 'tool', name: 'Grep', detail: 'x' });
      return { text: replies[Math.min(calls.length - 1, replies.length - 1)], sessionId: `sess-${calls.length}` };
    }),
  };
  const store = new ExplanationStore(mkdtempSync(join(tmpdir(), 'ed-es-')));
  const git = { showStat: async () => 'STAT', diff: async () => 'DIFF' };
  const svc = new ExplainService({
    git, runner, store, cwd: '/repo', timeoutMs: () => 1000, model: () => undefined, now: () => new Date('2026-10-08T15:10:00Z'),
  });
  return { svc, store, calls, runner };
}

const good = JSON.stringify(fixture);

describe('ExplainService.explain', () => {
  it('generates, stores, and then serves from cache', async () => {
    const { svc, store, calls } = setup([good]);
    const progress: string[] = [];
    const r = await svc.explain({ sha: 'abc', brief: 'BRIEF' }, { onProgress: (p) => p.type === 'tool' && progress.push(p.detail) });
    expect(r).toMatchObject({ sha: 'abc', explainerSessionId: 'sess-1', inferred: false, thread: [] });
    expect(calls[0].prompt).toContain('BRIEF');
    expect(calls[0].prompt).toContain('DIFF');
    expect(progress).toEqual(['x']);
    expect(await store.get('abc')).toBeDefined();
    await svc.explain({ sha: 'abc', brief: 'BRIEF' });
    expect(calls).toHaveLength(1);
  });

  it('force regenerates', async () => {
    const { svc, calls } = setup([good]);
    await svc.explain({ sha: 'abc', brief: null });
    await svc.explain({ sha: 'abc', brief: null }, { force: true });
    expect(calls).toHaveLength(2);
  });

  it('marks explanations without a session as inferred', async () => {
    const { svc } = setup([good]);
    const r = await svc.explain({ sha: 'abc', brief: null });
    expect(r.inferred).toBe(true);
    expect(r.explanation.why.inferred).toBe(true);
  });

  it('repairs invalid JSON once by resuming the same Claude session', async () => {
    const { svc, calls } = setup(['Sorry, here: {"summary": 1}', '```json\n' + good + '\n```']);
    const r = await svc.explain({ sha: 'abc', brief: 'B' });
    expect(calls).toHaveLength(2);
    expect(calls[1].resumeSessionId).toBe('sess-1');
    expect(calls[1].prompt).toContain('summary');
    expect(r.explainerSessionId).toBe('sess-2');
  });

  it('gives up after one repair and caches nothing', async () => {
    const { svc, store } = setup(['nope', 'still nope']);
    const err = await svc.explain({ sha: 'abc', brief: 'B' }).catch((e) => e);
    expect(err).toBeInstanceOf(ExplanationInvalidError);
    expect(err.raw).toBe('still nope');
    expect(await store.get('abc')).toBeUndefined();
  });
});

describe('ExplainService.repairDiagram', () => {
  it('asks for one diagram, stores the fixed code, and returns it', async () => {
    const { svc, store, calls } = setup([good, '```mermaid\nflowchart LR\n  A --> B\n```']);
    await svc.explain({ sha: 'abc', brief: 'B' });
    const fixed = await svc.repairDiagram('abc', 'ripple.diagramMermaid', 'flowchart LR\n A(-->B', 'Parse error');
    expect(fixed).toBe('flowchart LR\n  A --> B');
    expect(calls[1].prompt).toContain('Parse error');
    expect(calls[1].maxTurns).toBe(1);
    expect((await store.get('abc'))!.explanation.ripple.diagramMermaid).toBe(fixed);
  });
});

describe('ExplainService review fixes', () => {
  it('Regenerate keeps the chat history and starts the next question fresh', async () => {
    const { svc, store } = setup([good]);
    const first = await svc.explain({ sha: 'abc', brief: 'B' });
    await store.put({ ...first, thread: [{ question: 'Q', answer: 'A', askedAt: 't', filesChecked: [] }] });
    const r = await svc.explain({ sha: 'abc', brief: 'B' }, { force: true });
    expect(r.thread).toHaveLength(1);
    expect(r.explainerSessionId).toBe('');
    expect((await store.get('abc'))!.thread).toHaveLength(1);
  });

  it('joins a second request for the same commit instead of starting another run', async () => {
    const { svc, calls } = setup([good]);
    const [a, b] = await Promise.all([svc.explain({ sha: 'abc', brief: 'B' }), svc.explain({ sha: 'abc', brief: 'B' })]);
    expect(calls).toHaveLength(1);
    expect(a.sha).toBe(b.sha);
  });

  it('keeps every fix when several diagrams are repaired at the same time', async () => {
    const { svc, store } = setup([good, 'flowchart LR\n  F1 --> F2']);
    await svc.explain({ sha: 'abc', brief: 'B' });
    await Promise.all([
      svc.repairDiagram('abc', 'ripple.diagramMermaid', 'x', 'e'),
      svc.repairDiagram('abc', 'howItWorks.diagramMermaid', 'y', 'e'),
      svc.repairDiagram('abc', 'why.timelineMermaid', 'z', 'e'),
    ]);
    const e = (await store.get('abc'))!.explanation;
    expect([e.ripple.diagramMermaid, e.howItWorks.diagramMermaid, e.why.timelineMermaid]).toEqual(Array(3).fill('flowchart LR\n  F1 --> F2'));
  });
});
