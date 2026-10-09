import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscriptFile } from '../../src/harnesses/claude-code/transcript';
import { buildBrief, estimateTokens } from '../../src/core/briefBuilder';
import type { Session, SessionEvent } from '../../src/core/types';

const FIXTURE = join(__dirname, '../fixtures/sessions/basic.jsonl');

describe('buildBrief', () => {
  it('contains header, prompts, window detail, edited files and later commits', async () => {
    const session = await parseTranscriptFile(FIXTURE);
    const brief = buildBrief({
      session, eventIndex: 5, commitTime: '2026-10-08T14:35:05Z',
      laterCommits: [{ shortSha: '7f03b11', subject: 'Retry failed deliveries' }], budgetTokens: 30000,
    });
    expect(brief).toContain('Title: Fix duplicate webhook charges');
    expect(brief).toContain('Customers got charged twice');
    expect(brief).toContain('## Around the commit (full detail)');
    expect(brief).toContain('USER: /review the handler');
    expect(brief).toContain('RESULT: [feat/webhook-retry a1c9e42]');
    expect(brief).toContain('- src/webhooks/handler.ts');
    expect(brief).toContain('- 7f03b11 Retry failed deliveries');
    expect(brief).not.toContain('Committed.'); // after the commit
  });

  it('uses commit time when there is no event index', async () => {
    const session = await parseTranscriptFile(FIXTURE);
    const brief = buildBrief({ session, eventIndex: null, commitTime: '2026-10-08T14:10:00Z', laterCommits: [], budgetTokens: 30000 });
    expect(brief).toContain('USER: Customers got charged twice');
    expect(brief).not.toContain('handler.ts'); // edit happened after 14:10
  });

  it('trims outside-window prose first, then prompts, never the window', () => {
    const long = (n: number) => `First sentence ${n}. ${'Middle words here. '.repeat(200)}Last sentence ${n}.`;
    const events: SessionEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push({ kind: 'user', time: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`, text: `Prompt ${i} ${'x'.repeat(2000)}` });
      events.push({ kind: 'assistant', time: `2026-01-01T00:${String(i).padStart(2, '0')}:30Z`, text: long(i) });
    }
    events.push({ kind: 'user', time: '2026-01-01T01:00:00Z', text: 'Final request WINDOW-MARKER' });
    events.push({ kind: 'toolResult', time: '2026-01-01T01:00:10Z', toolUseId: 'c', text: '[main abc1234] done' });
    const session: Session = { id: 's', sourceId: 'claude-code', title: 'T', start: events[0].time, end: '2026-01-01T01:00:10Z', events, editedFiles: [], filePath: '/s' };

    const brief = buildBrief({ session, eventIndex: events.length - 1, commitTime: '2026-01-01T01:00:10Z', laterCommits: [], budgetTokens: 4000 });
    expect(brief).toContain('WINDOW-MARKER');
    expect(brief).toContain('[main abc1234] done');
    expect(brief).not.toContain('Middle words here. Middle words here.');
    expect(estimateTokens(brief)).toBeLessThanOrEqual(4000);
  });
});
