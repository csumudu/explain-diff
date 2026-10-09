import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/explanation.json';
import { toMarkdown } from '../../src/core/markdownExport';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';

describe('toMarkdown', () => {
  const md = toMarkdown(
    {
      sha: 'abc', promptVersion: PROMPT_VERSION, generatedAt: '2026-10-08T15:10:00Z', explainerSessionId: 's', inferred: false,
      explanation: fixture as unknown as Explanation,
      thread: [{ question: 'Why only possibly?', section: 'Ripple map', answer: 'Because it reads the API.', askedAt: '2026-10-09T09:00:00Z', filesChecked: ['src/admin/EventsPage.tsx'] }],
    },
    { shortSha: 'a1c9e42', subject: 'Make webhook handler idempotent', branch: 'feat/webhook-retry', date: '2026-10-08T14:35:00Z', sessionTitle: 'Fix duplicate webhook charges' },
  );

  it('has a title, metadata and all eight sections in order', () => {
    expect(md.startsWith('# Make webhook handler idempotent (a1c9e42)')).toBe(true);
    expect(md).toContain('Session: Fix duplicate webhook charges');
    const order = ['## 1. In one breath', '## 2. Why we did this', '## 3. What changed', '## 4. How it works now',
      '## 5. Ripple map: who uses this', '## 6. What to expect', '## 7. Watch-outs', '## 8. Glossary', '## Conversation'];
    const idx = order.map((h) => md.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('renders diagrams as mermaid fences and quotes the user', () => {
    expect(md).toContain('```mermaid\nsequenceDiagram');
    expect(md).toContain('> Customers got charged twice.');
  });

  it('includes the conversation with section labels', () => {
    expect(md).toContain('**Q (about "Ripple map"):** Why only possibly?');
    expect(md).toContain('Because it reads the API.');
  });
});
