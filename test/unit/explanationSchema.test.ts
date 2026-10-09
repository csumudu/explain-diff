import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/explanation.json';
import { parseExplanation, extractJson, extractMermaid, getDiagram, setDiagram } from '../../src/core/explanationSchema';

describe('extractJson', () => {
  it('accepts bare JSON, fenced JSON, and JSON surrounded by prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":{"b":2}} hope this helps')).toEqual({ a: { b: 2 } });
  });
  it('throws when no object is present', () => {
    expect(() => extractJson('no json here')).toThrow(/No JSON object/);
  });
});

describe('parseExplanation', () => {
  it('accepts a valid explanation', () => {
    const r = parseExplanation(JSON.stringify(fixture));
    expect(r.ok).toBe(true);
  });
  it('reports schema errors with paths', () => {
    const bad = { ...fixture, summary: 5 };
    const r = parseExplanation(JSON.stringify(bad));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('summary');
  });
  it('reports JSON syntax errors', () => {
    expect(parseExplanation('{"summary": ').ok).toBe(false);
  });
});

describe('diagram helpers', () => {
  it('extracts mermaid from fences or plain text', () => {
    expect(extractMermaid('```mermaid\nflowchart LR\n A-->B\n```')).toBe('flowchart LR\n A-->B');
    expect(extractMermaid('  flowchart LR\n A-->B  ')).toBe('flowchart LR\n A-->B');
  });
  it('gets and sets diagrams by key', () => {
    const r = parseExplanation(JSON.stringify(fixture));
    if (!r.ok) throw new Error('fixture invalid');
    setDiagram(r.value, 'ripple.diagramMermaid', 'flowchart TD\n X-->Y');
    expect(getDiagram(r.value, 'ripple.diagramMermaid')).toBe('flowchart TD\n X-->Y');
    expect(getDiagram(r.value, 'why.timelineMermaid')).toContain('timeline');
  });
});
