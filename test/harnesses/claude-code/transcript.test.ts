import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscriptFile, parseTranscriptLines, cleanUserText } from '../../../src/harnesses/claude-code/transcript';

const FIXTURE = join(__dirname, '../../fixtures/sessions/basic.jsonl');

describe('parseTranscriptFile', () => {
  it('reads session metadata', async () => {
    const s = await parseTranscriptFile(FIXTURE);
    expect(s.id).toBe('s1');
    expect(s.title).toBe('Fix duplicate webhook charges');
    expect(s.branch).toBe('feat/webhook-retry');
    expect(s.start).toBe('2026-10-08T14:02:00.000Z');
    expect(s.end).toBe('2026-10-08T14:36:00.000Z');
    expect(s.filePath).toBe(FIXTURE);
  });

  it('keeps prompts, prose and tool traffic in order; skips meta, thinking, sidechain, malformed lines', async () => {
    const s = await parseTranscriptFile(FIXTURE);
    expect(s.events.map((e) => e.kind)).toEqual([
      'user', 'assistant', 'toolCall', 'user', 'toolCall', 'toolResult', 'assistant',
    ]);
    expect(s.events[3]).toMatchObject({ kind: 'user', text: '/review the handler' });
    expect(s.events[5]).toMatchObject({ kind: 'toolResult', toolUseId: 'tu2' });
    expect((s.events[5] as { text: string }).text).toContain('[feat/webhook-retry a1c9e42]');
  });

  it('collects edited files', async () => {
    const s = await parseTranscriptFile(FIXTURE);
    expect(s.editedFiles).toEqual(['src/webhooks/handler.ts']);
  });

  it('falls back to the first prompt for the title and the file name for the id', async () => {
    const s = await parseTranscriptLines(
      ['{"type":"user","message":{"content":"Add a dark mode toggle to settings please"},"timestamp":"2026-01-01T00:00:00.000Z"}'],
      '/x/abc-123.jsonl',
    );
    expect(s.id).toBe('abc-123');
    expect(s.title).toBe('Add a dark mode toggle to settings please');
  });
});

describe('cleanUserText', () => {
  it('drops local command caveats and strips system reminders', () => {
    expect(cleanUserText('<local-command-stdout>x</local-command-stdout>')).toBe('');
    expect(cleanUserText('hi <system-reminder>secret</system-reminder> there')).toBe('hi  there');
  });
});

describe('normalised fields', () => {
  it('marks the source and fills shellCommand / editedFile on tool calls', async () => {
    const s = await parseTranscriptFile(FIXTURE);
    expect(s.sourceId).toBe('claude-code');
    const calls = s.events.filter((e) => e.kind === 'toolCall') as Extract<(typeof s.events)[number], { kind: 'toolCall' }>[];
    expect(calls.find((c) => c.name === 'Edit')?.editedFile).toBe('src/webhooks/handler.ts');
    expect(calls.find((c) => c.name === 'Bash')?.shellCommand).toBe('git commit -m "Make webhook handler idempotent"');
    expect(calls.find((c) => c.name === 'Edit')?.shellCommand).toBeUndefined();
  });
});
