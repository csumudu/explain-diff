import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../fixtures/explanation.json';
import { ExplanationStore } from '../../src/core/explanationStore';
import { QAService, parseSectionPrefix } from '../../src/core/qaService';
import { ExplainerRunError, ExplainerTimeoutError } from '../../src/harnesses/errors';
import type { RunOptions } from '../../src/harnesses/types';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';

async function setup(run: (o: RunOptions, n: number) => Promise<{ text: string; sessionId: string }>) {
  const store = new ExplanationStore(mkdtempSync(join(tmpdir(), 'ed-qa-')));
  await store.put({
    sha: 'abc', promptVersion: PROMPT_VERSION, generatedAt: 'g', explainerSessionId: 'sess-explain',
    inferred: false, explanation: fixture as unknown as Explanation, thread: [],
  });
  const calls: RunOptions[] = [];
  const runner = { run: vi.fn(async (o: RunOptions) => { calls.push(o); return run(o, calls.length); }) };
  const qa = new QAService({ runner, store, cwd: '/r', timeoutMs: () => 1000, model: () => undefined, now: () => new Date('2026-10-09T09:00:00Z') });
  return { qa, store, calls };
}

describe('parseSectionPrefix', () => {
  it('splits an About "X": prefix', () => {
    expect(parseSectionPrefix('About "Ripple map": why?')).toEqual({ section: 'Ripple map', question: 'why?' });
    expect(parseSectionPrefix('plain question')).toEqual({ question: 'plain question' });
  });
});

describe('QAService', () => {
  it('resumes the explanation session, records the turn with section and files, and stores the new session id', async () => {
    const { qa, store, calls } = await setup(async (o) => {
      o.onProgress?.({ type: 'tool', name: 'Read', detail: 'src/a.ts' });
      return { text: '  The answer.  ', sessionId: 'sess-2' };
    });
    const r = await qa.ask('abc', 'About "Ripple map": Why only possibly?', { brief: 'B' });
    expect(calls[0].resumeSessionId).toBe('sess-explain');
    expect(calls[0].prompt).toContain('"Ripple map" section');
    expect(r).toEqual({
      usedFallback: false,
      turn: { question: 'Why only possibly?', section: 'Ripple map', answer: 'The answer.', askedAt: '2026-10-09T09:00:00.000Z', filesChecked: ['src/a.ts'] },
    });
    const s = await store.get('abc');
    expect(s!.thread).toHaveLength(1);
    expect(s!.explainerSessionId).toBe('sess-2');
  });

  it('falls back to a fresh run with the explanation and history when resume fails', async () => {
    const { qa, calls } = await setup(async (o, n) => {
      if (n === 1) throw new ExplainerRunError('No conversation found', 1, '');
      return { text: 'Fresh answer', sessionId: 'sess-fresh' };
    });
    const r = await qa.ask('abc', 'Q?', { brief: 'BRIEF' });
    expect(r.usedFallback).toBe(true);
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(calls[1].prompt).toContain('BRIEF');
    expect(calls[1].prompt).toContain('"summary"');
  });

  it('does not fall back on timeouts', async () => {
    const { qa } = await setup(async () => { throw new ExplainerTimeoutError('slow'); });
    await expect(qa.ask('abc', 'Q?', { brief: null })).rejects.toBeInstanceOf(ExplainerTimeoutError);
  });

  it('clear() empties the thread and makes the next question start fresh', async () => {
    const { qa, store, calls } = await setup(async () => ({ text: 'A', sessionId: 'sess-x' }));
    await qa.ask('abc', 'Q1', { brief: null });
    await qa.clear('abc');
    expect((await store.get('abc'))!.thread).toEqual([]);
    const r = await qa.ask('abc', 'Q2', { brief: null });
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(r.usedFallback).toBe(false);
  });

  it('refuses when there is no explanation yet', async () => {
    const { qa } = await setup(async () => ({ text: 'A', sessionId: 's' }));
    await expect(qa.ask('zzz', 'Q', { brief: null })).rejects.toThrow(/No explanation/);
  });
});

describe('QAService concurrency', () => {
  it('a clear() during an in-flight answer is not undone when the answer is saved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { qa, store } = await setup(async (_o, n) => {
      if (n === 2) await gate;
      return { text: `A${n}`, sessionId: `sess-${n}` };
    });
    await qa.ask('abc', 'Q1', { brief: null });
    const pending = qa.ask('abc', 'Q2', { brief: null });
    await new Promise((r) => setTimeout(r, 20));
    await qa.clear('abc');
    release();
    await pending;
    const s = (await store.get('abc'))!;
    expect(s.thread.map((t) => t.question)).toEqual(['Q2']);
  });
});
