import { stat } from 'node:fs/promises';
import type { SessionSource } from '../harnesses/types';
import type { Session } from './types';

/** Reads every source's sessions for these folders. One failing source or file never hides the others. */
export async function collectSessions(
  sources: SessionSource[],
  workspacePaths: string[],
  cache: Map<string, { mtimeMs: number; session: Session }>,
): Promise<Session[]> {
  const seen = new Set<string>();
  const sessions: Session[] = [];
  for (const source of sources) {
    let files: string[];
    try {
      files = await source.findSessionFiles(workspacePaths);
    } catch {
      continue;
    }
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        const { mtimeMs } = await stat(file);
        const key = `${source.id}:${file}`;
        const hit = cache.get(key);
        if (hit && hit.mtimeMs === mtimeMs) {
          sessions.push(hit.session);
          continue;
        }
        const session = await source.parseSession(file);
        cache.set(key, { mtimeMs, session });
        sessions.push(session);
      } catch {
        // unreadable or unparseable session: skip it
      }
    }
  }
  return sessions;
}
