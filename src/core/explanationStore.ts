import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROMPT_VERSION } from './explanationSchema';
import type { StoredExplanation } from './types';

export function repoStoreDir(globalStorageDir: string, repoRoot: string): string {
  const key = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return join(globalStorageDir, 'explanations', createHash('sha1').update(key).digest('hex').slice(0, 16));
}

export class ExplanationStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  /** Runs fn after every earlier locked operation on the same commit has finished. */
  private withLock<T>(sha: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(sha) ?? Promise.resolve()).catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(sha, tail);
    void tail.then(() => {
      if (this.locks.get(sha) === tail) this.locks.delete(sha);
    });
    return run;
  }

  private file(sha: string) {
    return join(this.dir, `${sha}.json`);
  }

  async get(sha: string): Promise<StoredExplanation | undefined> {
    try {
      const data = JSON.parse(await readFile(this.file(sha), 'utf8')) as StoredExplanation & { claudeSessionId?: string };
      if (data.promptVersion !== PROMPT_VERSION) return undefined;
      if (data.explainerSessionId === undefined && typeof data.claudeSessionId === 'string') {
        data.explainerSessionId = data.claudeSessionId; // caches written before the rename
        delete data.claudeSessionId;
      }
      return data;
    } catch {
      return undefined;
    }
  }

  put(e: StoredExplanation): Promise<void> {
    return this.withLock(e.sha, () => this.write(e));
  }

  /** Re-reads the entry inside the lock, lets fn change it, and saves it. Returns undefined when nothing is cached. */
  update(sha: string, fn: (e: StoredExplanation) => void | Promise<void>): Promise<StoredExplanation | undefined> {
    return this.withLock(sha, async () => {
      const e = await this.get(sha);
      if (!e) return undefined;
      await fn(e);
      await this.write(e);
      return e;
    });
  }

  /** Builds the new entry from the current one (if any) inside the lock, and saves it. */
  upsert(sha: string, fn: (prev: StoredExplanation | undefined) => StoredExplanation): Promise<StoredExplanation> {
    return this.withLock(sha, async () => {
      const next = fn(await this.get(sha));
      await this.write(next);
      return next;
    });
  }

  private async write(e: StoredExplanation): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(e.sha)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(e, null, 2), 'utf8');
    await rename(tmp, this.file(e.sha));
  }

  async listCachedShas(): Promise<Set<string>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return new Set();
    }
    const shas = new Set<string>();
    for (const n of names.filter((n) => n.endsWith('.json'))) {
      const sha = n.slice(0, -5);
      if (await this.get(sha)) shas.add(sha);
    }
    return shas;
  }
}
