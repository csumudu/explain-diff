import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

export async function findTranscriptFiles(
  projectsDir: string,
  workspacePaths: string[],
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const norm = (s: string) => (platform === 'win32' ? s.toLowerCase() : s);
  const slugs = workspacePaths.map((p) => norm(projectSlug(p)));
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => slugs.some((slug) => norm(name) === slug || norm(name).startsWith(`${slug}--claude-worktrees-`)));

  const files = new Set<string>();
  for (const d of dirs) {
    let inner;
    try {
      inner = await readdir(join(projectsDir, d), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) if (f.isFile() && f.name.endsWith('.jsonl')) files.add(join(projectsDir, d, f.name));
  }
  return [...files].sort();
}
