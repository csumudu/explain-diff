import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessions } from '../../src/core/sessionCollector';
import type { Session } from '../../src/core/types';
import type { SessionSource } from '../../src/harnesses/types';

const dir = mkdtempSync(join(tmpdir(), 'ed-collect-'));
const f1 = join(dir, 'a.log');
const f2 = join(dir, 'b.log');
writeFileSync(f1, 'a');
writeFileSync(f2, 'b');

const session = (file: string, sourceId: string): Session => ({ id: file, sourceId, title: file, start: '', end: '', events: [], editedFiles: [], filePath: file });
const source = (id: string, files: string[] | Error, parse?: (f: string) => Promise<Session>): SessionSource & { parses: number } => {
  const s = {
    id, displayName: id, parses: 0,
    findSessionFiles: async () => { if (files instanceof Error) throw files; return files; },
    parseSession: async (f: string) => { s.parses++; return parse ? parse(f) : session(f, id); },
  };
  return s;
};

describe('collectSessions', () => {
  it('lists each session file once even when sources or paths overlap', async () => {
    const a = source('a', [f1, f1, f2]);
    const b = source('b', [f2]);
    const out = await collectSessions([a, b], ['/w'], new Map());
    expect(out.map((s) => s.filePath).sort()).toEqual([f1, f2].sort());
  });

  it('keeps other sources working when one source fails to list or parse', async () => {
    const broken = source('broken', new Error('cannot read folder'));
    const badParse = source('bad', [f1], async () => { throw new Error('bad file'); });
    const ok = source('ok', [f2]);
    expect((await collectSessions([broken, badParse, ok], ['/w'], new Map())).map((s) => s.sourceId)).toEqual(['ok']);
  });

  it('reuses a cached parse while the file is unchanged', async () => {
    const a = source('a', [f1]);
    const cache = new Map();
    await collectSessions([a], ['/w'], cache);
    await collectSessions([a], ['/w'], cache);
    expect(a.parses).toBe(1);
  });
});
