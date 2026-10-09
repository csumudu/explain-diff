import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/explanation.json';
import { esc, rich, renderExplainView, renderChatThread, renderAnswer, dayLabel, type HeaderInfo } from '../../src/webview/render';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';
import type { StoredExplanation } from '../../src/core/types';

const header: HeaderInfo = { explainerName: 'Claude Code', shortSha: 'a1c9e42', subject: 'Make <b>handler</b> idempotent', branch: 'feat/x', date: '2026-10-08T14:35:00Z', added: 48, removed: 12, fileCount: 4, sessionTitle: 'Fix', generatedAt: '2026-10-08T15:10:00Z', hasTranscript: true };
const stored = (e: unknown = fixture): StoredExplanation => ({ sha: 'abc', promptVersion: PROMPT_VERSION, generatedAt: 'g', explainerSessionId: 's', inferred: false, explanation: e as Explanation, thread: [] });
const ready = (e?: unknown, extra: Partial<{ failedDiagrams: Record<string, string>; maxDiffTabs: number }> = {}) =>
  renderExplainView({
    kind: 'ready', header, stored: stored(e), maxDiffTabs: extra.maxDiffTabs ?? 20, failedDiagrams: extra.failedDiagrams ?? {},
    files: [{ status: 'M', path: 'src/webhooks/handler.ts', added: 22, removed: 6, binary: false }, { status: 'A', path: 'logo.png', added: null, removed: null, binary: true }],
  });

describe('escaping and links', () => {
  it('escapes HTML', () => {
    expect(esc(`<img src=x onerror="a">'`)).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&#39;');
  });
  it('turns path:line into openRef links and backticks into code', () => {
    const h = rich('See `src/a.ts:12` and lib/b.tsx:3.');
    expect(h).toContain('<code><a href="#" class="ref" data-action="openRef" data-path="src/a.ts" data-line="12">src/a.ts:12</a></code>');
    expect(h).toContain('data-path="lib/b.tsx" data-line="3"');
  });
  it('does not linkify URLs with ports', () => {
    expect(rich('http://example.com:8080')).not.toContain('data-action');
  });
});

describe('renderExplainView ready', () => {
  const html = ready();
  it('renders header, all sections with Ask buttons, and diagrams as source', () => {
    expect(html).toContain('Make &lt;b&gt;handler&lt;/b&gt; idempotent');
    for (const t of ['In one breath', 'Why we did this', 'What changed', 'How it works now', 'Ripple map', 'What to expect', 'Watch-outs', 'Glossary']) {
      expect(html).toContain(`data-action="askSection" data-section="${t}`);
    }
    expect(html).toContain('<figure class="diagram" data-key="howItWorks.diagramMermaid">');
    expect(html).toContain('<pre class="mermaid-src">sequenceDiagram');
  });
  it('makes file chips focus their diff tab and marks binary files', () => {
    expect(html).toContain('data-action="focusFile" data-path="src/webhooks/handler.ts"');
    expect(html).toContain('logo.png');
    expect(html).toContain('binary');
  });
  it('offers "Open all N changes" only above the tab limit', () => {
    expect(html).not.toContain('Open all 1 changes');
    expect(ready(undefined, { maxDiffTabs: 0 })).toContain('Open all 1 changes');
  });
  it('shows a failed diagram with its error and a retry button', () => {
    const h = ready(undefined, { failedDiagrams: { 'ripple.diagramMermaid': 'Parse error on line 2' } });
    expect(h).toContain('class="diagram failed" data-key="ripple.diagramMermaid"');
    expect(h).toContain('Parse error on line 2');
    expect(h).toContain('data-action="retryDiagram" data-key="ripple.diagramMermaid"');
  });
  it('escapes hostile model output everywhere', () => {
    const evil = JSON.parse(JSON.stringify(fixture));
    evil.summary = '<script>alert(1)</script>';
    evil.glossary[0].term = '<img src=x onerror=alert(1)>';
    evil.ripple.possiblyRelated[0].path = 'a"onmouseover="x.ts';
    const h = ready(evil);
    expect(h).not.toContain('<script>alert');
    expect(h).not.toContain('<img src=x');
    expect(h).not.toContain('"onmouseover="');
  });
  it('labels inferred reasoning', () => {
    const inf = JSON.parse(JSON.stringify(fixture));
    inf.why.inferred = true;
    expect(ready(inf)).toContain('INFERRED');
  });
});

describe('renderExplainView states', () => {
  it('renders loading steps, log and cancel', () => {
    const h = renderExplainView({ kind: 'loading', header, steps: [{ label: 'Read session', state: 'done' }, { label: 'Claude is exploring the code', state: 'active' }], log: ['Grep  <x>'] });
    expect(h).toContain('Claude is exploring the code');
    expect(h).toContain('Grep  &lt;x&gt;');
    expect(h).toContain('data-action="cancel"');
  });
  it('renders the CLI-missing and failed states', () => {
    expect(renderExplainView({ kind: 'error', header, variant: 'cliMissing', message: 'm' })).toContain('data-action="openSettings"');
    const f = renderExplainView({ kind: 'error', header, variant: 'failed', message: 'Timed out', details: 'exit 143' });
    expect(f).toContain('Timed out');
    expect(f).toContain('exit 143');
    expect(f).toContain('data-action="retry"');
  });
});

describe('chat rendering', () => {
  // local-time dates so the test passes in every timezone
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
  const now = new Date(2026, 9, 9, 12);
  it('labels days', () => {
    expect(dayLabel(at(9, 8), now)).toBe('Today');
    expect(dayLabel(at(8, 8), now)).toMatch(/^Yesterday · Oct 8$/);
    expect(dayLabel(at(1, 8), now)).toBe('Oct 1');
  });
  it('renders history grouped by day, section labels, files and the pending answer (no suggestions while pending)', () => {
    const h = renderChatThread({
      commit: { shortSha: 'a1c9e42', subject: 's' },
      thread: [
        { question: 'Q1 <b>', answer: 'A1 see `src/a.ts:3`', askedAt: at(8, 10), filesChecked: ['src/a.ts'] },
        { question: 'Q2', section: 'Ripple map', answer: 'A2', askedAt: at(9, 10), filesChecked: [] },
      ],
      pending: { question: 'Q3', partial: 'Thinking so far', files: ['x.ts'] },
    }, now);
    expect(h.indexOf('Yesterday')).toBeLessThan(h.indexOf('Today'));
    expect(h).toContain('Q1 &lt;b&gt;');
    expect(h).toContain('About “Ripple map”');
    expect(h).toContain('data-path="src/a.ts" data-line="3"');
    expect(h).toContain('Checked: src/a.ts');
    expect(h).toContain('Thinking so far');
    expect(h).not.toContain('data-action="suggest"');
  });
  it('shows suggestions on an empty thread and the unavailable message', () => {
    expect(renderChatThread({ thread: [] }, now)).toContain('What breaks if I revert this?');
    expect(renderChatThread({ thread: [], unavailable: 'Still writing' }, now)).toContain('Still writing');
  });
  it('renders answer markdown safely with mermaid blocks', () => {
    const h = renderAnswer('Para one <x>\n\n- item `a`\n- item b\n\n```mermaid\nflowchart LR\n A-->B\n```\n\n```ts\nconst a = 1 < 2;\n```', 'qa-0');
    expect(h).toContain('<p>Para one &lt;x&gt;</p>');
    expect(h).toContain('<li>item <code>a</code></li>');
    expect(h).toContain('<figure class="diagram" data-key="qa-0-0">');
    expect(h).toContain('<pre><code>const a = 1 &lt; 2;</code></pre>');
  });
});

describe('diagram maximize button', () => {
  it('rendered diagrams carry a hidden Maximize button that the webview reveals after rendering', () => {
    const html = renderExplainView({
      kind: 'ready', header, stored: stored(), maxDiffTabs: 20, failedDiagrams: {}, files: [],
    });
    expect(html).toContain('<button class="maximize" data-action="maximizeDiagram" aria-label="Maximize diagram" hidden>');
  });
  it('failed diagrams have no Maximize button', () => {
    const html = renderExplainView({
      kind: 'ready', header, stored: stored(), maxDiffTabs: 20, files: [],
      failedDiagrams: { 'why.timelineMermaid': 'e', 'howItWorks.diagramMermaid': 'e', 'ripple.diagramMermaid': 'e' },
    });
    expect(html).not.toContain('data-action="maximizeDiagram"');
  });
  it('chat answer diagrams get the button too', () => {
    expect(renderAnswer('```mermaid\nflowchart LR\n A-->B\n```', 'qa-1')).toContain('data-action="maximizeDiagram"');
  });
});
describe('explainer-neutral copy', () => {
  it('names the explainer in loading, footer and the missing-tool state', () => {
    const h = { ...header, explainerName: 'Some Agent' };
    expect(renderExplainView({ kind: 'loading', header: h, steps: [{ label: 'Some Agent is exploring the code', state: 'active' }], log: [] })).toContain('Some Agent is exploring the code');
    expect(renderExplainView({ kind: 'ready', header: h, stored: stored(), files: [], maxDiffTabs: 20, failedDiagrams: {} })).toContain('Written by Some Agent');
    const missing = renderExplainView({ kind: 'error', header: h, variant: 'cliMissing', message: 'not found', setup: { message: 'Install Some Agent.', docsUrl: 'https://example.com/docs' } });
    expect(missing).toContain('Some Agent is needed to write explanations');
    expect(missing).toContain('Install Some Agent.');
    expect(missing).toContain('href="https://example.com/docs"');
  });
});
