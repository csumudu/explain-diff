import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/explanation.json';
import { buildExplainPrompt, buildQaFallbackPrompt, buildQaPrompt, truncateDiff } from '../../src/core/prompts';
import type { Explanation } from '../../src/core/explanationSchema';

const fileDiff = (name: string, size: number) => `diff --git a/${name} b/${name}\n${'+x\n'.repeat(size)}`;

describe('truncateDiff', () => {
  it('returns small diffs unchanged', () => {
    const d = fileDiff('a.ts', 3);
    expect(truncateDiff(d, 1000)).toBe(d);
  });
  it('keeps the largest file diffs that fit and lists the omitted files', () => {
    const d = fileDiff('small.ts', 10) + fileDiff('big.ts', 200) + fileDiff('huge.ts', 5000);
    const out = truncateDiff(d, 1000);
    expect(out).toContain('diff --git a/big.ts');
    expect(out).toContain('diff --git a/small.ts');
    expect(out).not.toContain('diff --git a/huge.ts');
    expect(out).toContain('Omitted from this prompt (read them yourself with git show): huge.ts');
    expect(out.length).toBeLessThan(1200);
  });
});

describe('buildExplainPrompt', () => {
  it('includes the rules, schema, commit, diff and brief', () => {
    const p = buildExplainPrompt({ sha: 'abc', brief: 'BRIEF-TEXT', stat: 'STAT-TEXT', diff: 'DIFF-TEXT' });
    for (const s of ['BRIEF-TEXT', 'STAT-TEXT', 'DIFF-TEXT', 'COMMIT abc', 'possiblyRelated', 'path:line', 'ONE JSON object']) {
      expect(p).toContain(s);
    }
    expect(p).not.toContain('There is no session transcript');
  });
  it('tells Claude to infer when there is no session', () => {
    const p = buildExplainPrompt({ sha: 'abc', brief: null, stat: 's', diff: 'd' });
    expect(p).toContain('There is no session transcript');
    expect(p).toContain('why.inferred to true');
  });
});

describe('Q&A prompts', () => {
  it('mentions the section when given', () => {
    expect(buildQaPrompt('Why?', 'Ripple map')).toContain('about the "Ripple map" section');
  });
  it('fallback prompt carries explanation and thread', () => {
    const p = buildQaFallbackPrompt({
      brief: null, explanation: fixture as unknown as Explanation,
      thread: [{ question: 'Q1?', answer: 'A1.', askedAt: '2026-10-08T10:00:00Z', filesChecked: [] }], question: 'Q2?',
    });
    expect(p).toContain('Q1?');
    expect(p).toContain('A1.');
    expect(p).toContain('Q2?');
    expect(p).toContain('"summary"');
  });
});
