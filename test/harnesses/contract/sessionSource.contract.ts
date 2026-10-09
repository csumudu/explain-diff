import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findCommitRefs } from '../../../src/core/commitLinker';
import type { SessionSource } from '../../../src/harnesses/types';

interface Expectations {
  workspacePath: string;
  unrelatedWorkspacePath: string;
  /** A session file (found for workspacePath) that contains at least one corrupt or truncated entry. */
  malformedFile: string;
  sessions: {
    file: string;
    title: string;
    branch?: string;
    minEvents: number;
    shellCommandContains: string;
    editedFile: string;
    commitShortSha: string;
  }[];
}

/**
 * Every SessionSource must pass this suite against its own fixtures.
 * `fixtureDir` holds `expectations.json` and whatever on-disk layout the harness uses.
 */
export function describeSessionSource(name: string, makeSource: (fixtureDir: string) => SessionSource, fixtureDir: string): void {
  const exp = JSON.parse(readFileSync(join(fixtureDir, 'expectations.json'), 'utf8')) as Expectations;
  const platform: NodeJS.Platform = 'win32';

  describe(`SessionSource contract: ${name}`, () => {
    it('has a kebab-case id and a display name', () => {
      const s = makeSource(fixtureDir);
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.displayName.trim()).not.toBe('');
    });

    it('finds exactly the sessions recorded for the workspace', async () => {
      const files = await makeSource(fixtureDir).findSessionFiles([exp.workspacePath], platform);
      expect(files.map((f) => basename(f)).sort()).toEqual(exp.sessions.map((s) => s.file).sort());
    });

    it('finds nothing for an unrelated folder', async () => {
      expect(await makeSource(fixtureDir).findSessionFiles([exp.unrelatedWorkspacePath], platform)).toEqual([]);
    });

    it('parses a session file that contains a malformed entry without throwing', async () => {
      const s = makeSource(fixtureDir);
      const file = (await s.findSessionFiles([exp.workspacePath], platform)).find((f) => basename(f) === exp.malformedFile);
      expect(file, 'expectations.malformedFile must name a session file found for workspacePath').toBeDefined();
      await expect(s.parseSession(file!)).resolves.toMatchObject({ sourceId: s.id });
    });

    for (const e of exp.sessions) {
      describe(e.file, () => {
        const load = async () => {
          const s = makeSource(fixtureDir);
          const file = (await s.findSessionFiles([exp.workspacePath], platform)).find((f) => basename(f) === e.file)!;
          return { source: s, session: await s.parseSession(file) };
        };

        it('parses metadata and tags the session with the source id', async () => {
          const { source, session } = await load();
          expect(session.sourceId).toBe(source.id);
          expect(session.title).toBe(e.title);
          if (e.branch) expect(session.branch).toBe(e.branch);
          expect(session.events.length).toBeGreaterThanOrEqual(e.minEvents);
        });

        it('keeps events in time order', async () => {
          const times = (await load()).session.events.map((ev) => ev.time).filter(Boolean);
          expect([...times].sort()).toEqual(times);
        });

        it('normalises shell commands and edited files', async () => {
          const calls = (await load()).session.events.filter((ev) => ev.kind === 'toolCall') as { shellCommand?: string; editedFile?: string }[];
          expect(calls.some((c) => c.shellCommand?.includes(e.shellCommandContains))).toBe(true);
          expect(calls.some((c) => c.editedFile === e.editedFile)).toBe(true);
        });

        it('exposes the commit so the linker can find it', async () => {
          expect(findCommitRefs((await load()).session).map((r) => r.shortSha)).toContain(e.commitShortSha);
        });
      });
    }
  });
}
