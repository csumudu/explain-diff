# Explain Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code / Cursor extension that lists the commits Claude Code sessions made (grouped by session) and, for a selected commit, opens a tab set — a plain-language, diagram-rich "360°" explanation plus one diff tab per changed file — with a chat panel beside it whose history is kept per commit.

**Architecture:** Pure TypeScript core (`src/core`, no `vscode` imports) parses Claude Code JSONL transcripts, links commits to sessions via git, builds a token-budgeted session brief, and drives the `claude` CLI (`claude -p --output-format stream-json`) to produce a zod-validated explanation JSON, cached per commit. Pure HTML renderers (`src/webview/render.ts`) turn that JSON into webview markup; thin `src/vscode` glue provides the sidebar tree, the commit tab set (explanation webview + `vscode.diff` tabs), and the chat webview in the beside column.

**Tech Stack:** TypeScript 5, esbuild, VS Code API `^1.90`, zod 3, mermaid 11 (bundled into webviews), vitest, @vscode/test-cli + @vscode/test-electron, @vscode/vsce.

**Spec:** `docs/superpowers/specs/2026-10-09-explain-diff-design.md` (UI canvas: https://claude.ai/artifact/VnU2968pKwtSawqCv9agAM — boards Main, States, DiffTab)

## Global Constraints

- VS Code engine `^1.90`; only the standard extension API (must run unchanged in Cursor).
- Strictly read-only towards git: only `git log/show/rev-parse/branch --contains/cat-file`; never commit, checkout, reset or write refs.
- Claude is invoked only through the user's `claude` CLI; no API keys. Allowed tools: `Read,Grep,Glob,Bash(git show:*),Bash(git log:*),Bash(git grep:*)`; disallowed: `Edit,Write,NotebookEdit`; `--max-turns 40`.
- The prompt is sent on **stdin**, never as a command-line argument. On Windows the CLI is spawned through the shell.
- Transcripts are read from `~/.claude/projects/<slug>/` where slug = path with every non-alphanumeric char replaced by `-`; worktree dirs are `<slug>--claude-worktrees-*`.
- Brief budget default 30,000 tokens (tokens ≈ chars/4); the commit window is never trimmed.
- Diff included in the prompt is capped at 40,000 characters.
- Timeout default 180 s. Only fully valid explanations are cached.
- Cache: `context.globalStorageUri/explanations/<repoId>/<sha>.json`, keyed by `sha` + `PROMPT_VERSION`.
- Settings: `explainDiff.claudePath` (`claude`), `explainDiff.timeoutSeconds` (180), `explainDiff.model` (""), `explainDiff.briefTokenBudget` (30000), `explainDiff.maxDiffTabs` (20).
- Webviews: strict CSP with nonce; mermaid bundled (no CDN); all model-produced text is HTML-escaped before insertion.
- Plain language in all user-facing copy; no emoji in UI.

## Review Focus

1. **Windows + `claude.cmd` + huge prompt:** npm installs `claude.cmd`, which `spawn` cannot run without a shell, and a ~100k-char prompt exceeds cmd.exe's 8,191-char line limit → spawn through the shell with quoted args and send the prompt on stdin. Pinned in Task 7 (`buildSpawn` quoting test + 200k-char prompt round-trip test).
2. **Drive-letter casing:** VS Code reports `c:\Users\…` while Claude Code wrote `C--Users-…` → slug directories must match case-insensitively on Windows. Pinned in Task 2.
3. **`git commit` output variants:** `[detached HEAD abc1234]`, `[main (root-commit) abc1234]`, branches with slashes, two commits in one tool result → all linked. Pinned in Task 4.
4. **Claude wraps JSON** in ```` ```json ```` fences or adds a sentence before/after it → still parsed; invalid JSON triggers exactly one repair round. Pinned in Tasks 6 and 8.
5. **Hostile text in model output** (`<script>`, `<img onerror>`, quotes in paths) must render as text, never as HTML, in both the explanation and chat. Pinned in Task 11.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, esbuild.mjs, .vscode-test.mjs, .vscodeignore, .gitignore, README.md
media/icon.svg                      activity-bar icon
media/webview.css                   shared webview styles (theme variables)
src/core/types.ts                   shared data types
src/core/transcriptParser.ts        JSONL → Session
src/core/sessionLocator.ts          workspace → transcript files
src/core/gitService.ts              git CLI wrapper
src/core/commitLinker.ts            commits ↔ sessions
src/core/briefBuilder.ts            session brief for one commit
src/core/explanationSchema.ts       zod schema, Explanation type, PROMPT_VERSION, parse helpers
src/core/prompts.ts                 all prompt text + diff truncation
src/core/claudeRunner.ts            spawn `claude`, parse stream-json
src/core/explanationStore.ts        cache files
src/core/explainService.ts          generate / validate / repair explanations
src/core/qaService.ts               chat questions, resume + fallback, clear
src/core/markdownExport.ts          explanation + thread → Markdown
src/core/treeModel.ts               LinkResult → tree nodes (+ filter)
src/core/tabPlan.ts                 changed files → diff tab specs
src/shared/messages.ts              webview ↔ host message types
src/webview/render.ts               pure HTML renderers (explanation, states, chat)
src/webview/diagrams.ts             mermaid rendering in the browser
src/webview/explainMain.ts          explanation webview script
src/webview/chatMain.ts             chat webview script
src/vscode/extension.ts             activate(): wiring, commands, watcher
src/vscode/commitsTree.ts           TreeDataProvider
src/vscode/commitTabs.ts            diff content provider + tab set open/close
src/vscode/explainPanel.ts          explanation webview panel
src/vscode/chatPanel.ts             chat webview panel (beside)
src/vscode/controller.ts            open-commit orchestration
test/unit/*.test.ts                 vitest unit tests
test/fixtures/sessions/basic.jsonl  transcript fixture
test/fixtures/explanation.json      valid explanation fixture
test/fake-claude/fake-claude.mjs    fake CLI for runner/service tests
test/smoke/makeFixture.mjs          builds fixture repo + transcripts for smoke test
test/smoke/extension.test.cjs       VS Code smoke test
```

---

### Task 1: Project scaffold, shared types, TranscriptParser

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/types.ts`, `src/core/transcriptParser.ts`
- Create: `test/fixtures/sessions/basic.jsonl`
- Test: `test/unit/transcriptParser.test.ts`

**Interfaces:**
- Produces: all types in `src/core/types.ts` (used by every later task); `parseTranscriptFile(filePath: string): Promise<Session>`; `parseTranscriptLines(lines: AsyncIterable<string> | Iterable<string>, filePath: string): Promise<Session>`; `cleanUserText(text: string): string`.

- [ ] **Step 1: Create the scaffold**

`package.json`:

```json
{
  "name": "explain-diff",
  "displayName": "Explain Diff",
  "description": "Plain-language, diagram-rich explanations of the commits Claude Code made, with the session's context.",
  "version": "0.1.0",
  "publisher": "local",
  "license": "MIT",
  "engines": { "vscode": "^1.90.0" },
  "main": "./dist/extension.js",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "test/unit"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts'], testTimeout: 20000 },
});
```

`.gitignore`:

```
node_modules/
dist/
.vscode-test/
*.vsix
```

Run:

```bash
npm install -D typescript@5 vitest @types/node@20 @types/vscode@1.90.0
npm install zod@3
```

- [ ] **Step 2: Write shared types** — `src/core/types.ts`

```ts
import type { Explanation } from './explanationSchema';

export type SessionEvent =
  | { kind: 'user'; time: string; text: string }
  | { kind: 'assistant'; time: string; text: string }
  | { kind: 'toolCall'; time: string; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'toolResult'; time: string; toolUseId: string; text: string };

export interface Session {
  id: string;
  title: string;
  branch?: string;
  cwd?: string;
  start: string; // ISO
  end: string; // ISO
  events: SessionEvent[];
  editedFiles: string[];
  filePath: string;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorDate: string; // ISO 8601 with offset
  claudeCoAuthored: boolean;
}

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T';

export interface ChangedFile {
  status: ChangeStatus;
  path: string;
  oldPath?: string;
  added: number | null; // null for binary
  removed: number | null;
  binary: boolean;
}

export interface LinkedCommit {
  commit: CommitInfo;
  eventIndex: number | null;
  via: 'transcript' | 'trailer' | 'none';
}

export interface SessionGroup {
  session: Session;
  commits: LinkedCommit[];
}

export interface LinkResult {
  groups: SessionGroup[];
  other: LinkedCommit[];
}

export interface QaTurn {
  question: string;
  section?: string;
  answer: string;
  askedAt: string;
  filesChecked: string[];
}

export interface StoredExplanation {
  sha: string;
  promptVersion: number;
  generatedAt: string;
  claudeSessionId: string;
  inferred: boolean;
  explanation: Explanation;
  thread: QaTurn[];
}
```

`types.ts` imports `Explanation` from `explanationSchema.ts`, which Task 6 creates. To keep Task 1 compiling, create a temporary stub now. Task 6 replaces it:

`src/core/explanationSchema.ts` (temporary):

```ts
export type Explanation = Record<string, unknown>;
```

- [ ] **Step 3: Create the fixture** — `test/fixtures/sessions/basic.jsonl` (one JSON object per line, exactly these 12 lines; line 7 is deliberately malformed)

```
{"type":"ai-title","aiTitle":"Fix duplicate webhook charges","sessionId":"s1"}
{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>x</local-command-caveat>"},"timestamp":"2026-10-08T14:01:00.000Z","sessionId":"s1","cwd":"/repo","gitBranch":"feat/webhook-retry"}
{"type":"user","message":{"role":"user","content":"Customers got charged twice. Find out why and fix it."},"timestamp":"2026-10-08T14:02:00.000Z","sessionId":"s1","cwd":"/repo","gitBranch":"feat/webhook-retry"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]},"timestamp":"2026-10-08T14:03:00.000Z","sessionId":"s1","gitBranch":"feat/webhook-retry"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The handler never checks event IDs. I will store processed IDs."}]},"timestamp":"2026-10-08T14:09:00.000Z","sessionId":"s1","gitBranch":"feat/webhook-retry"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Edit","input":{"file_path":"src/webhooks/handler.ts","old_string":"a","new_string":"b"}}]},"timestamp":"2026-10-08T14:20:00.000Z","sessionId":"s1","gitBranch":"feat/webhook-retry"}
{broken
{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent noise"}]},"timestamp":"2026-10-08T14:21:00.000Z","sessionId":"s1"}
{"type":"user","message":{"role":"user","content":"<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the handler</command-args>"},"timestamp":"2026-10-08T14:30:00.000Z","sessionId":"s1","gitBranch":"feat/webhook-retry"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu2","name":"Bash","input":{"command":"git commit -m \"Make webhook handler idempotent\""}}]},"timestamp":"2026-10-08T14:35:00.000Z","sessionId":"s1","gitBranch":"feat/webhook-retry"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu2","content":[{"type":"text","text":"[feat/webhook-retry a1c9e42] Make webhook handler idempotent\n 2 files changed"}]}]},"timestamp":"2026-10-08T14:35:05.000Z","sessionId":"s1","gitBranch":"feat/webhook-retry"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Committed."}]},"timestamp":"2026-10-08T14:36:00.000Z","sessionId":"s1","gitBranch":"feat/webhook-retry"}
```

- [ ] **Step 4: Write the failing test** — `test/unit/transcriptParser.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscriptFile, parseTranscriptLines, cleanUserText } from '../../src/core/transcriptParser';

const FIXTURE = join(__dirname, '../fixtures/sessions/basic.jsonl');

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
```

- [ ] **Step 5: Run the test and confirm it fails**

Run: `npx vitest run test/unit/transcriptParser.test.ts`
Expected: FAIL. The module `../../src/core/transcriptParser` can't be found.

- [ ] **Step 6: Implement** — `src/core/transcriptParser.ts`

```ts
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import type { Session, SessionEvent } from './types';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export async function parseTranscriptFile(filePath: string): Promise<Session> {
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  return parseTranscriptLines(rl, filePath);
}

export async function parseTranscriptLines(
  lines: AsyncIterable<string> | Iterable<string>,
  filePath: string,
): Promise<Session> {
  const events: SessionEvent[] = [];
  const edited = new Set<string>();
  let id = '';
  let title: string | undefined;
  let branch: string | undefined;
  let cwd: string | undefined;
  let start = '';
  let end = '';

  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    if (!id && typeof obj.sessionId === 'string') id = obj.sessionId;
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      title = obj.aiTitle;
      continue;
    }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    if (obj.isSidechain || obj.isMeta) continue;

    const time: string = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    if (time) {
      if (!start || time < start) start = time;
      if (!end || time > end) end = time;
    }
    if (typeof obj.gitBranch === 'string' && obj.gitBranch) branch = obj.gitBranch;
    if (typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;

    const content = obj.message?.content;
    if (obj.type === 'user') {
      if (typeof content === 'string') {
        const text = cleanUserText(content);
        if (text) events.push({ kind: 'user', time, text });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text') {
            const text = cleanUserText(String(b.text ?? ''));
            if (text) events.push({ kind: 'user', time, text });
          } else if (b?.type === 'tool_result') {
            events.push({ kind: 'toolResult', time, toolUseId: String(b.tool_use_id ?? ''), text: toolResultText(b.content) });
          }
        }
      }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          events.push({ kind: 'assistant', time, text: b.text.trim() });
        } else if (b?.type === 'tool_use') {
          const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
          events.push({ kind: 'toolCall', time, id: String(b.id ?? ''), name: String(b.name ?? ''), input });
          if (EDIT_TOOLS.has(String(b.name)) && typeof input.file_path === 'string') edited.add(input.file_path);
        }
      }
    }
  }

  if (!title) {
    const first = events.find((e) => e.kind === 'user') as { text: string } | undefined;
    title = first ? first.text.slice(0, 60) : 'Untitled session';
  }
  return {
    id: id || basename(filePath).replace(/\.jsonl$/, ''),
    title,
    branch,
    cwd,
    start,
    end,
    events,
    editedFiles: [...edited],
    filePath,
  };
}

export function cleanUserText(text: string): string {
  if (text.startsWith('<local-command-')) return '';
  let t = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const cmd = t.match(/<command-name>(.*?)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
  if (cmd) t = `${cmd[1]} ${cmd[2]}`;
  return t.trim();
}

function toolResultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x: any) => (x?.type === 'text' ? String(x.text ?? '') : '')).join('\n');
  return '';
}
```

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/transcriptParser.test.ts && npm run typecheck`
Expected: all tests PASS and no type errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: scaffold project and parse Claude Code transcripts"
```

---

### Task 2: SessionLocator

**Files:**
- Create: `src/core/sessionLocator.ts`
- Test: `test/unit/sessionLocator.test.ts`

**Interfaces:**
- Produces: `projectSlug(path: string): string`; `findTranscriptFiles(projectsDir: string, workspacePaths: string[], platform?: NodeJS.Platform): Promise<string[]>` (absolute paths, de-duplicated, sorted).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug, findTranscriptFiles } from '../../src/core/sessionLocator';

describe('projectSlug', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(projectSlug('C:\\Users\\me\\projects\\explain-diff')).toBe('C--Users-me-projects-explain-diff');
    expect(projectSlug('/home/me/my_app')).toBe('-home-me-my-app');
  });
});

describe('findTranscriptFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ed-proj-'));
    const mk = (d: string, files: string[]) => {
      mkdirSync(join(dir, d), { recursive: true });
      for (const f of files) writeFileSync(join(dir, d, f), '');
    };
    mk('C--work-app', ['a.jsonl', 'notes.txt']);
    mk('C--work-app--claude-worktrees-feature-x', ['b.jsonl']);
    mk('C--work-app-other', ['c.jsonl']);
  });

  it('finds the project dir and its worktree dirs only', async () => {
    const files = await findTranscriptFiles(dir, ['C:\\work\\app'], 'linux');
    expect(files.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'))).toEqual([
      'C--work-app--claude-worktrees-feature-x/b.jsonl',
      'C--work-app/a.jsonl',
    ]);
  });

  it('matches drive-letter case-insensitively on Windows', async () => {
    expect(await findTranscriptFiles(dir, ['c:\\work\\app'], 'win32')).toHaveLength(2);
    expect(await findTranscriptFiles(dir, ['c:\\work\\app'], 'linux')).toHaveLength(0);
  });

  it('de-duplicates when several workspace paths map to the same dir', async () => {
    expect(await findTranscriptFiles(dir, ['C:\\work\\app', 'c:\\work\\app'], 'win32')).toHaveLength(2);
  });

  it('returns [] when the projects dir does not exist', async () => {
    expect(await findTranscriptFiles(join(dir, 'missing'), ['C:\\work\\app'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/sessionLocator.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/sessionLocator.ts`

```ts
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/sessionLocator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: locate Claude Code transcripts for a workspace"
```

---

### Task 3: GitService

**Files:**
- Create: `src/core/gitService.ts`
- Test: `test/unit/gitService.test.ts`

**Interfaces:**
- Consumes: `CommitInfo`, `ChangedFile`, `ChangeStatus` from `types.ts`.
- Produces: `class GitService` with `constructor(cwd: string, gitPath = 'git')` and these methods:
  - `repoRoot(): Promise<string | null>`
  - `resolveCommit(ref: string): Promise<string | null>`
  - `getCommit(sha: string): Promise<CommitInfo | null>`
  - `listClaudeCommits(): Promise<CommitInfo[]>`
  - `branchesContaining(sha: string): Promise<string[]>`
  - `showStat(sha: string): Promise<string>`
  - `diff(sha: string): Promise<string>`
  - `changedFiles(sha: string): Promise<ChangedFile[]>`
  - `fileAt(ref: string, path: string): Promise<string>` returns `''` on any failure.
- Also exported: `CLAUDE_TRAILER: RegExp`.

- [ ] **Step 1: Write the failing test** — `test/unit/gitService.test.ts`

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from '../../src/core/gitService';

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('GitService', () => {
  let repo: string;
  let first: string;
  let second: string;
  let git: GitService;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ed-git-'));
    g(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'old.txt'), 'rename me\n'.repeat(20));
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'First commit');
    first = g(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(repo, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
    renameSync(join(repo, 'old.txt'), join(repo, 'new.txt'));
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'Second commit\n\nBody line.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    second = g(repo, 'rev-parse', 'HEAD');
    git = new GitService(repo);
  });

  it('finds the repo root and resolves short SHAs', async () => {
    const norm = (p: string) => realpathSync.native(p).toLowerCase().replace(/\\/g, '/');
    expect(norm((await git.repoRoot())!)).toBe(norm(repo)); // realpath expands Windows 8.3 temp names
    expect(await git.resolveCommit(second.slice(0, 7))).toBe(second);
    expect(await git.resolveCommit('deadbeef')).toBeNull();
  });

  it('reads commit info and the Claude trailer', async () => {
    const c = await git.getCommit(second);
    expect(c).toMatchObject({ sha: second, subject: 'Second commit', claudeCoAuthored: true });
    expect(c!.body).toContain('Body line.');
    expect(c!.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await git.getCommit(first))!.claudeCoAuthored).toBe(false);
  });

  it('lists only Claude co-authored commits', async () => {
    expect((await git.listClaudeCommits()).map((c) => c.sha)).toEqual([second]);
  });

  it('lists branches containing a commit', async () => {
    expect(await git.branchesContaining(second)).toEqual(['main']);
  });

  it('reports changed files with status, rename and binary info', async () => {
    const files = await git.changedFiles(second);
    const by = (p: string) => files.find((f) => f.path === p)!;
    expect(by('a.txt')).toMatchObject({ status: 'M', added: 1, removed: 0, binary: false });
    expect(by('img.bin')).toMatchObject({ status: 'A', binary: true, added: null });
    expect(by('new.txt')).toMatchObject({ status: 'R', oldPath: 'old.txt' });
  });

  it('handles the root commit', async () => {
    const files = await git.changedFiles(first);
    expect(files.map((f) => f.status).sort()).toEqual(['A', 'A']);
    expect(await git.fileAt(`${first}^`, 'a.txt')).toBe('');
  });

  it('reads stat, diff and file contents', async () => {
    expect(await git.showStat(second)).toContain('a.txt');
    expect(await git.diff(second)).toContain('+two');
    expect(await git.fileAt(second, 'a.txt')).toBe('one\ntwo\n');
    expect(await git.fileAt(second, 'nope.txt')).toBe('');
  });

  it('returns null root outside a repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ed-plain-'));
    expect(await new GitService(plain).repoRoot()).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/gitService.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/gitService.ts`

```ts
import { execFile } from 'node:child_process';
import type { ChangedFile, ChangeStatus, CommitInfo } from './types';

export const CLAUDE_TRAILER = /^Co-Authored-By:\s*Claude\b/im;
const FMT = '%H%x1f%h%x1f%s%x1f%aI%x1f%b%x1e';

export class GitService {
  constructor(private readonly cwd: string, private readonly gitPath = 'git') {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        args,
        { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  }

  async repoRoot(): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '--show-toplevel'])).trim() || null;
    } catch {
      return null;
    }
  }

  async resolveCommit(ref: string): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  }

  async getCommit(sha: string): Promise<CommitInfo | null> {
    try {
      return parseLog(await this.run(['log', '-1', `--format=${FMT}`, sha]))[0] ?? null;
    } catch {
      return null;
    }
  }

  async listClaudeCommits(): Promise<CommitInfo[]> {
    try {
      return parseLog(await this.run(['log', '--all', `--format=${FMT}`])).filter((c) => c.claudeCoAuthored);
    } catch {
      return [];
    }
  }

  async branchesContaining(sha: string): Promise<string[]> {
    try {
      const out = await this.run(['branch', '--format=%(refname:short)', '--contains', sha]);
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  showStat(sha: string): Promise<string> {
    return this.run(['show', '--stat', '--format=fuller', '--no-color', sha]);
  }

  diff(sha: string): Promise<string> {
    return this.run(['show', '--format=', '--patch', '--no-color', '-M', sha]);
  }

  async changedFiles(sha: string): Promise<ChangedFile[]> {
    const [nameStatus, numstat] = await Promise.all([
      this.run(['show', '--format=', '--name-status', '-z', '-M', sha]),
      this.run(['show', '--format=', '--numstat', '-z', '-M', sha]),
    ]);
    const counts = parseNumstatZ(numstat);
    return parseNameStatusZ(nameStatus).map((f) => {
      const c = counts.get(f.path);
      const binary = c ? c.added === null : false;
      return { ...f, added: c?.added ?? (binary ? null : 0), removed: c?.removed ?? (binary ? null : 0), binary };
    });
  }

  async fileAt(ref: string, path: string): Promise<string> {
    try {
      return await this.run(['show', `${ref}:${path}`]);
    } catch {
      return '';
    }
  }
}

export function parseLog(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, shortSha, subject, authorDate, body = ''] = r.split('\x1f');
      return { sha, shortSha, subject, authorDate, body: body.trim(), claudeCoAuthored: CLAUDE_TRAILER.test(body) };
    });
}

function parseNameStatusZ(out: string): Omit<ChangedFile, 'added' | 'removed' | 'binary'>[] {
  const parts = out.split('\0').filter((p) => p !== '');
  const files: Omit<ChangedFile, 'added' | 'removed' | 'binary'>[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++];
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++];
      const path = parts[i++];
      files.push({ status, path, oldPath });
    } else {
      files.push({ status, path: parts[i++] });
    }
  }
  return files;
}

function parseNumstatZ(out: string): Map<string, { added: number | null; removed: number | null }> {
  const map = new Map<string, { added: number | null; removed: number | null }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].replace(/^\n/, '');
    if (!p) continue;
    const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
    if (!m) continue;
    const added = m[1] === '-' ? null : Number(m[1]);
    const removed = m[2] === '-' ? null : Number(m[2]);
    let path = m[3];
    if (path === '') {
      i += 2; // rename: old path, new path follow
      path = parts[i];
    }
    map.set(path, { added, removed });
  }
  return map;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/gitService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add read-only git service"
```

---

### Task 4: CommitLinker

**Files:**
- Create: `src/core/commitLinker.ts`
- Test: `test/unit/commitLinker.test.ts`

**Interfaces:**
- Consumes: `Session`, `CommitInfo`, `LinkedCommit`, `SessionGroup`, `LinkResult` from Task 1; the `GitService` method shapes from Task 3.
- Produces:
  - `type GitLike = Pick<GitService, 'resolveCommit' | 'getCommit' | 'listClaudeCommits' | 'branchesContaining'>`
  - `COMMIT_LINE: RegExp`
  - `findCommitRefs(session: Session): { shortSha: string; eventIndex: number }[]`
  - `eventIndexAt(session: Session, isoTime: string): number | null`
  - `linkCommits(sessions: Session[], git: GitLike): Promise<LinkResult>`

- [ ] **Step 1: Write the failing test** — `test/unit/commitLinker.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscriptFile, parseTranscriptLines } from '../../src/core/transcriptParser';
import { findCommitRefs, linkCommits, COMMIT_LINE, type GitLike } from '../../src/core/commitLinker';
import type { CommitInfo } from '../../src/core/types';

const commit = (sha: string, subject: string, authorDate: string, claude = true): CommitInfo => ({
  sha, shortSha: sha.slice(0, 7), subject, body: '', authorDate, claudeCoAuthored: claude,
});

function fakeGit(commits: CommitInfo[], branches: Record<string, string[]> = {}): GitLike {
  return {
    resolveCommit: async (ref) => commits.find((c) => c.sha.startsWith(ref))?.sha ?? null,
    getCommit: async (sha) => commits.find((c) => c.sha === sha) ?? null,
    listClaudeCommits: async () => commits.filter((c) => c.claudeCoAuthored),
    branchesContaining: async (sha) => branches[sha] ?? [],
  };
}

describe('COMMIT_LINE', () => {
  it.each([
    ['[main a1c9e42] msg', 'a1c9e42'],
    ['[feat/x-y a1c9e42] msg', 'a1c9e42'],
    ['[detached HEAD a1c9e42] msg', 'a1c9e42'],
    ['[main (root-commit) a1c9e42] msg', 'a1c9e42'],
  ])('parses %s', (line, sha) => {
    expect([...line.matchAll(COMMIT_LINE)].map((m) => m[2])).toEqual([sha]);
  });
});

describe('findCommitRefs', () => {
  it('finds commits in git commit tool results, including several in one result', async () => {
    const s = await parseTranscriptLines(
      [
        JSON.stringify({ type: 'assistant', timestamp: 't1', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'git add . && git commit -m a && git commit --allow-empty -m b' } }] } }),
        JSON.stringify({ type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '[main 1111111] a\n[main 2222222] b' }] } }),
        JSON.stringify({ type: 'assistant', timestamp: 't3', message: { content: [{ type: 'tool_use', id: 'y', name: 'Bash', input: { command: 'git log' } }] } }),
        JSON.stringify({ type: 'user', timestamp: 't4', message: { content: [{ type: 'tool_result', tool_use_id: 'y', content: '[main 3333333] not a commit call' }] } }),
      ],
      '/s.jsonl',
    );
    expect(findCommitRefs(s)).toEqual([
      { shortSha: '1111111', eventIndex: 1 },
      { shortSha: '2222222', eventIndex: 1 },
    ]);
  });
});

describe('linkCommits', () => {
  it('links via transcript, then via trailer + branch + time window, rest goes to other', async () => {
    const s1 = await parseTranscriptFile(join(__dirname, '../fixtures/sessions/basic.jsonl'));
    const direct = commit('a1c9e42ffffffffffffffffffffffffffffffff0', 'Make webhook handler idempotent', '2026-10-08T14:35:00Z');
    const viaTrailer = commit('bbbbbbbffffffffffffffffffffffffffffffff0', 'Late fix', '2026-10-08T14:40:00Z');
    const orphan = commit('cccccccffffffffffffffffffffffffffffffff0', 'Unrelated', '2026-10-01T09:00:00Z');
    const human = commit('dddddddffffffffffffffffffffffffffffffff0', 'Human commit', '2026-10-08T14:37:00Z', false);
    const git = fakeGit([direct, viaTrailer, orphan, human], { [viaTrailer.sha]: ['feat/webhook-retry'] });

    const r = await linkCommits([s1], git);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].commits.map((c) => [c.commit.subject, c.via, c.eventIndex])).toEqual([
      ['Make webhook handler idempotent', 'transcript', 5],
      ['Late fix', 'trailer', 6],
    ]);
    expect(r.other.map((c) => c.commit.subject)).toEqual(['Unrelated']);
  });

  it('drops commits that no longer exist and sessions without commits', async () => {
    const s1 = await parseTranscriptFile(join(__dirname, '../fixtures/sessions/basic.jsonl'));
    const r = await linkCommits([s1], fakeGit([]));
    expect(r).toEqual({ groups: [], other: [] });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/commitLinker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/commitLinker.ts`

```ts
import type { GitService } from './gitService';
import type { LinkResult, LinkedCommit, Session, SessionGroup } from './types';

export type GitLike = Pick<GitService, 'resolveCommit' | 'getCommit' | 'listClaudeCommits' | 'branchesContaining'>;

export const COMMIT_LINE = /^\[(.+?) (?:\(root-commit\) )?([0-9a-f]{7,40})\]/gm;
const GIT_COMMIT_CMD = /\bgit\b[^\n]*\bcommit\b/;
const WINDOW_SLACK_MS = 10 * 60 * 1000;

export function findCommitRefs(session: Session): { shortSha: string; eventIndex: number }[] {
  const commitCalls = new Set<string>();
  const refs: { shortSha: string; eventIndex: number }[] = [];
  session.events.forEach((e, i) => {
    if (e.kind === 'toolCall' && e.name === 'Bash' && typeof e.input.command === 'string' && GIT_COMMIT_CMD.test(e.input.command)) {
      commitCalls.add(e.id);
    }
    if (e.kind === 'toolResult' && commitCalls.has(e.toolUseId)) {
      for (const m of e.text.matchAll(COMMIT_LINE)) refs.push({ shortSha: m[2], eventIndex: i });
    }
  });
  return refs;
}

export function eventIndexAt(session: Session, isoTime: string): number | null {
  const t = Date.parse(isoTime);
  let idx: number | null = null;
  session.events.forEach((e, i) => {
    if (e.time && Date.parse(e.time) <= t) idx = i;
  });
  return idx;
}

export async function linkCommits(sessions: Session[], git: GitLike): Promise<LinkResult> {
  const assigned = new Map<string, { session: Session; linked: LinkedCommit }>();

  for (const session of sessions) {
    for (const ref of findCommitRefs(session)) {
      const sha = await git.resolveCommit(ref.shortSha);
      if (!sha || assigned.has(sha)) continue;
      const commit = await git.getCommit(sha);
      if (!commit) continue;
      assigned.set(sha, { session, linked: { commit, eventIndex: ref.eventIndex, via: 'transcript' } });
    }
  }

  const other: LinkedCommit[] = [];
  for (const commit of await git.listClaudeCommits()) {
    if (assigned.has(commit.sha)) continue;
    const t = Date.parse(commit.authorDate);
    const inWindow = sessions.filter(
      (s) => s.start && s.end && t >= Date.parse(s.start) && t <= Date.parse(s.end) + WINDOW_SLACK_MS,
    );
    let chosen: Session | undefined;
    if (inWindow.length) {
      const branches = await git.branchesContaining(commit.sha);
      chosen = inWindow
        .filter((s) => s.branch && branches.includes(s.branch))
        .sort((a, b) => Math.abs(Date.parse(a.end) - t) - Math.abs(Date.parse(b.end) - t))[0];
    }
    if (chosen) {
      assigned.set(commit.sha, { session: chosen, linked: { commit, eventIndex: eventIndexAt(chosen, commit.authorDate), via: 'trailer' } });
    } else {
      other.push({ commit, eventIndex: null, via: 'none' });
    }
  }

  const bySession = new Map<Session, SessionGroup>();
  for (const { session, linked } of assigned.values()) {
    if (!bySession.has(session)) bySession.set(session, { session, commits: [] });
    bySession.get(session)!.commits.push(linked);
  }
  const groups = [...bySession.values()].sort((a, b) => b.session.start.localeCompare(a.session.start));
  for (const g of groups) g.commits.sort((a, b) => Date.parse(a.commit.authorDate) - Date.parse(b.commit.authorDate));
  other.sort((a, b) => Date.parse(b.commit.authorDate) - Date.parse(a.commit.authorDate));
  return { groups, other };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/commitLinker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: link commits to the sessions that made them"
```

---

### Task 5: BriefBuilder

**Files:**
- Create: `src/core/briefBuilder.ts`
- Test: `test/unit/briefBuilder.test.ts`

**Interfaces:**
- Consumes: `Session`, `SessionEvent` (Task 1); `eventIndexAt` (Task 4).
- Produces: `interface BriefInput { session: Session; eventIndex: number | null; commitTime: string; laterCommits: { shortSha: string; subject: string }[]; budgetTokens: number }`, `buildBrief(input: BriefInput): string`, `estimateTokens(s: string): number`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { parseTranscriptFile } from '../../src/core/transcriptParser';
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
    const session: Session = { id: 's', title: 'T', start: events[0].time, end: '2026-01-01T01:00:10Z', events, editedFiles: [], filePath: '/s' };

    const brief = buildBrief({ session, eventIndex: events.length - 1, commitTime: '2026-01-01T01:00:10Z', laterCommits: [], budgetTokens: 4000 });
    expect(brief).toContain('WINDOW-MARKER');
    expect(brief).toContain('[main abc1234] done');
    expect(brief).not.toContain('Middle words here. Middle words here.');
    expect(estimateTokens(brief)).toBeLessThanOrEqual(4000);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/briefBuilder.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/briefBuilder.ts`

```ts
import { eventIndexAt } from './commitLinker';
import type { Session, SessionEvent } from './types';

export interface BriefInput {
  session: Session;
  eventIndex: number | null;
  commitTime: string;
  laterCommits: { shortSha: string; subject: string }[];
  budgetTokens: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

export function buildBrief(input: BriefInput): string {
  const { session, laterCommits, budgetTokens } = input;
  const events = session.events;
  const idx = input.eventIndex ?? eventIndexAt(session, input.commitTime) ?? events.length - 1;

  let windowStart = 0;
  for (let i = Math.min(idx, events.length - 1); i >= 0; i--) {
    if (events[i].kind === 'user') {
      windowStart = i;
      break;
    }
  }

  const prompts: { time: string; text: string }[] = [];
  const prose: { time: string; text: string }[] = [];
  events.slice(0, windowStart).forEach((e) => {
    if (e.kind === 'user') prompts.push({ time: e.time, text: e.text });
    if (e.kind === 'assistant') prose.push({ time: e.time, text: e.text });
  });
  const windowLines = events.slice(windowStart, idx + 1).map(formatWindowEvent);
  const edited = new Set<string>();
  events.slice(0, idx + 1).forEach((e) => {
    if (e.kind === 'toolCall' && EDIT_TOOLS.has(e.name) && typeof e.input.file_path === 'string') edited.add(e.input.file_path);
  });

  const render = () =>
    [
      '# Session',
      `Title: ${session.title}`,
      `Branch: ${session.branch ?? 'unknown'}`,
      `Started: ${session.start}`,
      '',
      '## What the user asked (in order)',
      ...prompts.map((p) => `- [${p.time}] ${p.text}`),
      '',
      '## What Claude said (before the commit window)',
      ...prose.map((p) => `- [${p.time}] ${p.text}`),
      '',
      '## Around the commit (full detail)',
      ...windowLines,
      '',
      '## Files edited before this commit',
      ...(edited.size ? [...edited].map((f) => `- ${f}`) : ['- none recorded']),
      '',
      '## Later commits in this session',
      ...(laterCommits.length ? laterCommits.map((c) => `- ${c.shortSha} ${c.subject}`) : ['- none']),
    ].join('\n');

  let brief = render();
  if (estimateTokens(brief) <= budgetTokens) return brief;

  for (const p of prose) p.text = firstAndLast(p.text);
  brief = render();
  if (estimateTokens(brief) <= budgetTokens) return brief;

  for (const p of prompts) p.text = p.text.slice(0, 300);
  brief = render();

  while (estimateTokens(brief) > budgetTokens && prose.length) {
    prose.shift();
    brief = render();
  }
  while (estimateTokens(brief) > budgetTokens && prompts.length) {
    prompts.shift();
    brief = render();
  }
  return brief;
}

function formatWindowEvent(e: SessionEvent): string {
  switch (e.kind) {
    case 'user':
      return `[${e.time}] USER: ${e.text}`;
    case 'assistant':
      return `[${e.time}] CLAUDE: ${e.text}`;
    case 'toolCall':
      return `[${e.time}] TOOL ${e.name}: ${JSON.stringify(e.input).slice(0, 500)}`;
    case 'toolResult':
      return `[${e.time}] RESULT: ${e.text.slice(0, 1000)}`;
  }
}

function firstAndLast(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length <= 2) return text;
  return `${sentences[0]} … ${sentences[sentences.length - 1]}`;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/briefBuilder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: build token-budgeted session briefs"
```

---

### Task 6: Explanation schema, prompts, JSON and diff helpers

**Files:**
- Modify (replace the stub): `src/core/explanationSchema.ts`
- Create: `src/core/prompts.ts`, `test/fixtures/explanation.json`
- Test: `test/unit/explanationSchema.test.ts`, `test/unit/prompts.test.ts`

**Interfaces:**
- Produces from `explanationSchema.ts`:
  - `ExplanationSchema` (zod)
  - `type Explanation`
  - `PROMPT_VERSION = 1`
  - `type DiagramKey = 'why.timelineMermaid' | 'howItWorks.diagramMermaid' | 'ripple.diagramMermaid'`
  - `DIAGRAM_KEYS: DiagramKey[]`
  - `extractJson(text: string): unknown`
  - `parseExplanation(text: string): { ok: true; value: Explanation } | { ok: false; error: string }`
  - `extractMermaid(text: string): string`
  - `getDiagram(e: Explanation, key: DiagramKey): string | undefined`
  - `setDiagram(e: Explanation, key: DiagramKey, code: string): void`
- Produces from `prompts.ts`:
  - `DIFF_CHAR_LIMIT = 40000`
  - `truncateDiff(diff: string, limit: number): string`
  - `buildExplainPrompt(i: { sha: string; brief: string | null; stat: string; diff: string }): string`
  - `buildJsonRepairPrompt(error: string): string`
  - `buildDiagramRepairPrompt(code: string, error: string): string`
  - `buildQaPrompt(question: string, section?: string): string`
  - `buildQaFallbackPrompt(i: { brief: string | null; explanation: Explanation; thread: QaTurn[]; question: string; section?: string }): string`

- [ ] **Step 1: Create the fixture** — `test/fixtures/explanation.json`

```json
{
  "summary": "Payment providers sometimes send the same event twice. Now the app remembers handled events and skips repeats, so a customer is charged once.",
  "why": {
    "inferred": false,
    "userQuotes": [{ "text": "Customers got charged twice. Find out why and fix it.", "time": "14:02" }],
    "narrative": "The webhook handler processed every event, even repeats.",
    "decisions": [
      { "choice": "Store handled event IDs in the database", "kind": "chosen", "reason": "Survives restarts and works across servers." },
      { "choice": "In-memory cache", "kind": "rejected", "reason": "Forgets everything on restart." }
    ],
    "timelineMermaid": "timeline\n  14:02 : You report double charges\n  14:35 : This commit"
  },
  "changes": [
    {
      "title": "The app now remembers which events it has handled",
      "before": "Every event was processed, even a repeat.",
      "after": "The handler saves the event ID first and skips repeats.",
      "files": [{ "path": "src/webhooks/handler.ts", "line": 31, "added": 22, "removed": 6 }]
    }
  ],
  "howItWorks": {
    "narrative": "A new ID goes on to charge; a repeat is acknowledged and skipped. See `src/webhooks/handler.ts:31`.",
    "diagramMermaid": "sequenceDiagram\n  Provider->>Handler: event\n  Handler->>DB: save ID\n  Handler-->>Provider: 200 OK"
  },
  "ripple": {
    "diagramMermaid": "flowchart LR\n  H[handleWebhook] --> R[routes/webhooks.ts]\n  H -.-> E[EventsPage.tsx]",
    "verified": [{ "path": "src/routes/webhooks.ts", "line": 18, "role": "Exposes the handler", "impact": "Unchanged for callers" }],
    "possiblyRelated": [{ "path": "src/admin/EventsPage.tsx", "reason": "Lists webhook events by name" }]
  },
  "expectations": { "effects": ["Customers are charged once per payment."], "howToVerify": ["Run `npm test -- webhooks`."] },
  "watchOuts": [{ "kind": "migration", "text": "Run the new migration before deploying." }],
  "glossary": [{ "term": "Webhook", "meaning": "A message another service sends when something happens." }]
}
```

- [ ] **Step 2: Write the failing tests**

`test/unit/explanationSchema.test.ts`:

```ts
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
```

`test/unit/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/explanation.json';
import { buildExplainPrompt, buildQaFallbackPrompt, buildQaPrompt, truncateDiff } from '../../src/core/prompts';
import type { Explanation } from '../../src/core/explanationSchema';

const fileDiff = (name: string, size: number) => `diff --git a/${name} b/${name}\n${'+x\n'.repeat(size)}`;

describe('truncateDiff', () => {
  it('returns small diffs unchanged', () => {
    const d = fileDiff('a.ts', 3);
    expect(truncateDiff(d, 1000)).toBe(d);
  });
  it('keeps the largest file diffs that fit and lists the omitted files', () => {
    const d = fileDiff('small.ts', 10) + fileDiff('big.ts', 200) + fileDiff('huge.ts', 5000);
    const out = truncateDiff(d, 1000);
    expect(out).toContain('diff --git a/big.ts');
    expect(out).toContain('diff --git a/small.ts');
    expect(out).not.toContain('diff --git a/huge.ts');
    expect(out).toContain('Omitted from this prompt (read them yourself with git show): huge.ts');
    expect(out.length).toBeLessThan(1200);
  });
});

describe('buildExplainPrompt', () => {
  it('includes the rules, schema, commit, diff and brief', () => {
    const p = buildExplainPrompt({ sha: 'abc', brief: 'BRIEF-TEXT', stat: 'STAT-TEXT', diff: 'DIFF-TEXT' });
    for (const s of ['BRIEF-TEXT', 'STAT-TEXT', 'DIFF-TEXT', 'COMMIT abc', 'possiblyRelated', 'path:line', 'ONE JSON object']) {
      expect(p).toContain(s);
    }
    expect(p).not.toContain('There is no session transcript');
  });
  it('tells Claude to infer when there is no session', () => {
    const p = buildExplainPrompt({ sha: 'abc', brief: null, stat: 's', diff: 'd' });
    expect(p).toContain('There is no session transcript');
    expect(p).toContain('why.inferred to true');
  });
});

describe('Q&A prompts', () => {
  it('mentions the section when given', () => {
    expect(buildQaPrompt('Why?', 'Ripple map')).toContain('about the "Ripple map" section');
  });
  it('fallback prompt carries explanation and thread', () => {
    const p = buildQaFallbackPrompt({
      brief: null, explanation: fixture as unknown as Explanation,
      thread: [{ question: 'Q1?', answer: 'A1.', askedAt: '2026-10-08T10:00:00Z', filesChecked: [] }], question: 'Q2?',
    });
    expect(p).toContain('Q1?');
    expect(p).toContain('A1.');
    expect(p).toContain('Q2?');
    expect(p).toContain('"summary"');
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/unit/explanationSchema.test.ts test/unit/prompts.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 4: Implement** — `src/core/explanationSchema.ts` (replaces the stub)

```ts
import { z } from 'zod';

export const PROMPT_VERSION = 1;

const FileRef = z.object({ path: z.string(), line: z.number().int().optional(), added: z.number().int(), removed: z.number().int() });

export const ExplanationSchema = z.object({
  summary: z.string(),
  why: z.object({
    inferred: z.boolean(),
    userQuotes: z.array(z.object({ text: z.string(), time: z.string().optional() })),
    narrative: z.string(),
    decisions: z.array(z.object({ choice: z.string(), kind: z.enum(['chosen', 'rejected']), reason: z.string() })),
    timelineMermaid: z.string().optional(),
  }),
  changes: z.array(z.object({ title: z.string(), before: z.string(), after: z.string(), files: z.array(FileRef) })),
  howItWorks: z.object({ narrative: z.string(), diagramMermaid: z.string() }),
  ripple: z.object({
    diagramMermaid: z.string(),
    verified: z.array(z.object({ path: z.string(), line: z.number().int(), role: z.string(), impact: z.string() })),
    possiblyRelated: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
  expectations: z.object({ effects: z.array(z.string()), howToVerify: z.array(z.string()) }),
  watchOuts: z.array(z.object({ kind: z.enum(['migration', 'risk', 'not-done', 'edge-case', 'follow-up']), text: z.string() })),
  glossary: z.array(z.object({ term: z.string(), meaning: z.string() })),
});

export type Explanation = z.infer<typeof ExplanationSchema>;
export type DiagramKey = 'why.timelineMermaid' | 'howItWorks.diagramMermaid' | 'ripple.diagramMermaid';
export const DIAGRAM_KEYS: DiagramKey[] = ['why.timelineMermaid', 'howItWorks.diagramMermaid', 'ripple.diagramMermaid'];

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object found in the reply');
  return JSON.parse(candidate.slice(start, end + 1));
}

export function parseExplanation(text: string): { ok: true; value: Explanation } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const r = ExplanationSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

export function extractMermaid(text: string): string {
  const fenced = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

export function getDiagram(e: Explanation, key: DiagramKey): string | undefined {
  if (key === 'why.timelineMermaid') return e.why.timelineMermaid;
  if (key === 'howItWorks.diagramMermaid') return e.howItWorks.diagramMermaid;
  return e.ripple.diagramMermaid;
}

export function setDiagram(e: Explanation, key: DiagramKey, code: string): void {
  if (key === 'why.timelineMermaid') e.why.timelineMermaid = code;
  else if (key === 'howItWorks.diagramMermaid') e.howItWorks.diagramMermaid = code;
  else e.ripple.diagramMermaid = code;
}
```

- [ ] **Step 5: Implement** — `src/core/prompts.ts`

```ts
import type { Explanation } from './explanationSchema';
import type { QaTurn } from './types';

export const DIFF_CHAR_LIMIT = 40000;

const SCHEMA_TEXT = `type Explanation = {
  summary: string;                         // 2-3 sentences a newcomer can follow
  why: {
    inferred: boolean;                     // true when there is no session transcript
    userQuotes: { text: string; time?: string }[];   // the user's own words from the session
    narrative: string;
    decisions: { choice: string; kind: "chosen" | "rejected"; reason: string }[];
    timelineMermaid?: string;              // Mermaid "timeline" of the session up to this commit
  };
  changes: {                               // grouped by purpose, not by file
    title: string; before: string; after: string;
    files: { path: string; line?: number; added: number; removed: number }[];
  }[];
  howItWorks: { narrative: string; diagramMermaid: string };   // flowchart or sequenceDiagram
  ripple: {
    diagramMermaid: string;                // flowchart: changed code in the middle, -.-> for unverified
    verified: { path: string; line: number; role: string; impact: string }[];
    possiblyRelated: { path: string; reason: string }[];
  };
  expectations: { effects: string[]; howToVerify: string[] };
  watchOuts: { kind: "migration" | "risk" | "not-done" | "edge-case" | "follow-up"; text: string }[];
  glossary: { term: string; meaning: string }[];
};`;

const WRITING_RULES = `RULES
- Write in plain language with short sentences. The reader is smart but new to this code.
- Every technical term you use must also appear in "glossary" with a simple meaning.
- Every claim about code must cite a real location as path:line, with the path relative to the repository root.
- You must not modify any files.`;

export function truncateDiff(diff: string, limit: number): string {
  if (diff.length <= limit) return diff;
  const chunks = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const order = chunks.map((c, i) => ({ c, i })).sort((a, b) => b.c.length - a.c.length);
  const keep = new Set<number>();
  let used = 0;
  for (const { c, i } of order) {
    if (used + c.length <= limit) {
      keep.add(i);
      used += c.length;
    }
  }
  const omitted = chunks.filter((_, i) => !keep.has(i)).map((c) => c.match(/^diff --git a\/(\S+)/)?.[1] ?? '?');
  const kept = chunks.filter((_, i) => keep.has(i)).join('');
  return `${kept}\nOmitted from this prompt (read them yourself with git show): ${omitted.join(', ')}\n`;
}

export function buildExplainPrompt(i: { sha: string; brief: string | null; stat: string; diff: string }): string {
  const intent = i.brief
    ? '- Base "why" on the session brief below. Quote the user\'s own words in why.userQuotes. Do not invent intent that is not in the brief.'
    : '- There is no session transcript for this commit. Set why.inferred to true, leave why.userQuotes empty, omit why.timelineMermaid, and base "why" only on the commit message and the code, saying clearly that it is a best guess.';
  return `You are explaining one git commit to a developer who did not watch it being made.
Give a complete "360 degree" view: what changed, why, how it works now, who else in the app uses it, what to expect, and what to watch out for.

${WRITING_RULES}
- Find who uses the changed code by actually searching the repository (Grep, Glob, Read, git grep). List a usage under ripple.verified only if you saw it in a search result or a file you read. Anything you suspect but did not confirm goes in ripple.possiblyRelated.
${intent}
- Diagrams are Mermaid source without code fences. Keep node labels short and do not put ( ) [ ] { } " or ; inside labels.

OUTPUT
Reply with ONE JSON object and nothing else, matching this TypeScript type:
${SCHEMA_TEXT}

COMMIT ${i.sha}
${i.stat}

DIFF
${i.diff}

SESSION BRIEF
${i.brief ?? '(none)'}
`;
}

export function buildJsonRepairPrompt(error: string): string {
  return `Your previous reply could not be used: ${error}
Reply again with ONE JSON object and nothing else, matching the Explanation type exactly. Keep the same content.`;
}

export function buildDiagramRepairPrompt(code: string, error: string): string {
  return `This Mermaid diagram fails to parse.
Error: ${error}

${code}

Reply with only the corrected Mermaid source, no code fences, no explanation. Keep the meaning. Keep labels short and avoid ( ) [ ] { } " ; inside labels.`;
}

export function buildQaPrompt(question: string, section?: string): string {
  const about = section ? ` The question is about the "${section}" section of your explanation.` : '';
  return `Follow-up question from the reader.${about}
Answer in plain language with short sentences. Cite code as path:line. Search or read code if you need to; you must not modify files.
You may include a Mermaid diagram in a \`\`\`mermaid block when it helps.

Question: ${question}`;
}

export function buildQaFallbackPrompt(i: {
  brief: string | null;
  explanation: Explanation;
  thread: QaTurn[];
  question: string;
  section?: string;
}): string {
  const history = i.thread.map((t) => `Reader: ${t.question}\nYou: ${t.answer}`).join('\n\n');
  return `You previously explained a git commit to a reader. Here is your explanation as JSON:
${JSON.stringify(i.explanation, null, 2)}

SESSION BRIEF
${i.brief ?? '(none)'}

CONVERSATION SO FAR
${history || '(none)'}

${buildQaPrompt(i.question, i.section)}`;
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/explanationSchema.test.ts test/unit/prompts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: explanation schema, prompts and diff truncation"
```

---

### Task 7: ClaudeRunner and the fake CLI

**Files:**
- Create: `src/core/claudeRunner.ts`, `test/fake-claude/fake-claude.mjs`
- Test: `test/unit/claudeRunner.test.ts`

**Interfaces:**
- Produces:
  - `ALLOWED_TOOLS`, `DISALLOWED_TOOLS`
  - `type RunProgress = { type: 'tool'; name: string; detail: string } | { type: 'text'; text: string }`
  - `interface RunOptions { cwd: string; prompt: string; resumeSessionId?: string; timeoutMs: number; model?: string; maxTurns?: number; signal?: AbortSignal; onProgress?: (p: RunProgress) => void }`
  - `interface RunResult { text: string; sessionId: string }`
  - error classes `ClaudeNotFoundError`, `ClaudeTimeoutError`, `ClaudeAbortedError`, and `ClaudeRunError` (with `exitCode: number | null` and `stderrTail: string`)
  - `buildArgs(o: Pick<RunOptions, 'resumeSessionId' | 'model' | 'maxTurns'>): string[]`
  - `buildSpawn(command: string, args: string[], platform: NodeJS.Platform): { file: string; args: string[]; shell: boolean }`
  - `class ClaudeRunner { constructor(command: string, prefixArgs?: string[], platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv); run(o: RunOptions): Promise<RunResult>; version(): Promise<string | null> }`

- [ ] **Step 1: Write the fake CLI** — `test/fake-claude/fake-claude.mjs`

```js
// Fake `claude` for tests. Behaviour is controlled by environment variables:
// FAKE_CLAUDE_MODE: ok | fail | slow | resume-missing   (default ok)
// FAKE_CLAUDE_RESULTS: path to a JSON array of result strings; call N returns item N (last repeats)
// FAKE_CLAUDE_COUNTER: path to a counter file (needed for FAKE_CLAUDE_RESULTS sequencing)
// FAKE_CLAUDE_LOG: path; each call appends {"args":[...],"stdinLength":n,"stdin":"..."} as one line
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('9.9.9 (Claude Code)\n');
  process.exit(0);
}
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const env = process.env;
if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdinLength: stdin.length, stdin: stdin.slice(0, 2000) }) + '\n');
const mode = env.FAKE_CLAUDE_MODE ?? 'ok';
const resumeIdx = args.indexOf('--resume');
const resume = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
const sid = 'sess-' + Math.random().toString(36).slice(2, 8);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let n = 0;
if (env.FAKE_CLAUDE_COUNTER) {
  n = existsSync(env.FAKE_CLAUDE_COUNTER) ? Number(readFileSync(env.FAKE_CLAUDE_COUNTER, 'utf8')) : 0;
  writeFileSync(env.FAKE_CLAUDE_COUNTER, String(n + 1));
}
if (mode === 'fail') {
  process.stderr.write('boom: something broke\n');
  process.exit(2);
}
if (mode === 'slow') await new Promise((r) => setTimeout(r, 60000));
if (mode === 'resume-missing' && resume) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}`, session_id: resume });
  process.exit(1);
}
const results = env.FAKE_CLAUDE_RESULTS ? JSON.parse(readFileSync(env.FAKE_CLAUDE_RESULTS, 'utf8')) : ['ok'];
const text = results[Math.min(n, results.length - 1)];
out({ type: 'system', subtype: 'init', session_id: sid });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'handleWebhook' } }] } });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/routes/webhooks.ts' } }] } });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
```

- [ ] **Step 2: Write the failing test** — `test/unit/claudeRunner.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeRunner, ClaudeNotFoundError, ClaudeRunError, ClaudeTimeoutError, ClaudeAbortedError,
  buildArgs, buildSpawn, ALLOWED_TOOLS, type RunProgress,
} from '../../src/core/claudeRunner';

const FAKE = join(__dirname, '../fake-claude/fake-claude.mjs');

describe('buildArgs / buildSpawn', () => {
  it('builds read-only stream-json args with optional resume and model', () => {
    const a = buildArgs({ resumeSessionId: 'abc', model: 'opus' });
    expect(a.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(a).toContain(ALLOWED_TOOLS);
    expect(a.join(' ')).toContain('--disallowedTools Edit,Write,NotebookEdit');
    expect(a.join(' ')).toContain('--max-turns 40');
    expect(a.slice(-4)).toEqual(['--model', 'opus', '--resume', 'abc']);
  });
  it('uses the shell with quoted args on Windows only', () => {
    expect(buildSpawn('claude', ['-p', 'Bash(git show:*)'], 'linux')).toEqual({ file: 'claude', args: ['-p', 'Bash(git show:*)'], shell: false });
    expect(buildSpawn('C:\\Program Files\\claude.cmd', ['-p', 'a "b"'], 'win32')).toEqual({
      file: '"C:\\Program Files\\claude.cmd" "-p" "a ""b"""', args: [], shell: true,
    });
  });
});

describe('ClaudeRunner with fake CLI', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const runner = () => new ClaudeRunner(process.execPath, [FAKE], process.platform, env);
  const base = () => ({ cwd: dir, prompt: 'hello', timeoutMs: 15000 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ed-run-'));
    writeFileSync(join(dir, 'results.json'), JSON.stringify(['{"answer":42}']));
    env = { ...process.env, FAKE_CLAUDE_RESULTS: join(dir, 'results.json'), FAKE_CLAUDE_COUNTER: join(dir, 'n'), FAKE_CLAUDE_LOG: join(dir, 'log') };
  });

  it('returns the result text and session id and reports tool progress', async () => {
    const progress: RunProgress[] = [];
    const r = await runner().run({ ...base(), onProgress: (p) => progress.push(p) });
    expect(r.text).toBe('{"answer":42}');
    expect(r.sessionId).toMatch(/^sess-/);
    expect(progress.filter((p) => p.type === 'tool')).toEqual([
      { type: 'tool', name: 'Grep', detail: 'handleWebhook' },
      { type: 'tool', name: 'Read', detail: 'src/routes/webhooks.ts' },
    ]);
  });

  it('sends a 200k-character prompt over stdin, not argv', async () => {
    await runner().run({ ...base(), prompt: 'x'.repeat(200_000) });
    const log = JSON.parse(readFileSync(join(dir, 'log'), 'utf8').trim());
    expect(log.stdinLength).toBe(200_000);
    expect(log.args.join(' ').length).toBeLessThan(1000);
  });

  it('passes --resume', async () => {
    await runner().run({ ...base(), resumeSessionId: 'sess-old' });
    const log = JSON.parse(readFileSync(join(dir, 'log'), 'utf8').trim());
    expect(log.args).toContain('--resume');
    expect(log.args).toContain('sess-old');
  });

  it('raises ClaudeRunError with stderr on failure', async () => {
    env.FAKE_CLAUDE_MODE = 'fail';
    const err = await runner().run(base()).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeRunError);
    expect(err.stderrTail).toContain('boom');
  });

  it('raises ClaudeRunError when the CLI reports an error result', async () => {
    env.FAKE_CLAUDE_MODE = 'resume-missing';
    const err = await runner().run({ ...base(), resumeSessionId: 'gone' }).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeRunError);
    expect(err.message).toContain('No conversation found');
  });

  it('times out', async () => {
    env.FAKE_CLAUDE_MODE = 'slow';
    await expect(runner().run({ ...base(), timeoutMs: 800 })).rejects.toBeInstanceOf(ClaudeTimeoutError);
  });

  it('can be cancelled', async () => {
    env.FAKE_CLAUDE_MODE = 'slow';
    const ac = new AbortController();
    const p = runner().run({ ...base(), signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toBeInstanceOf(ClaudeAbortedError);
  });

  it('reports a missing CLI', async () => {
    const r = new ClaudeRunner(join(dir, 'definitely-not-here-claude'), [], process.platform, env);
    await expect(r.run(base())).rejects.toBeInstanceOf(ClaudeNotFoundError);
    expect(await r.version()).toBeNull();
  });

  it('reads the version', async () => {
    expect(await runner().version()).toBe('9.9.9 (Claude Code)');
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run test/unit/claudeRunner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement** — `src/core/claudeRunner.ts`

```ts
import { spawn, execFile, type ChildProcess } from 'node:child_process';

export const ALLOWED_TOOLS = 'Read,Grep,Glob,Bash(git show:*),Bash(git log:*),Bash(git grep:*)';
export const DISALLOWED_TOOLS = 'Edit,Write,NotebookEdit';

export type RunProgress = { type: 'tool'; name: string; detail: string } | { type: 'text'; text: string };

export interface RunOptions {
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  timeoutMs: number;
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

export interface RunResult {
  text: string;
  sessionId: string;
}

export class ClaudeNotFoundError extends Error {}
export class ClaudeTimeoutError extends Error {}
export class ClaudeAbortedError extends Error {}
export class ClaudeRunError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderrTail: string) {
    super(message);
  }
}

export function buildArgs(o: Pick<RunOptions, 'resumeSessionId' | 'model' | 'maxTurns'>): string[] {
  const a = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', ALLOWED_TOOLS,
    '--disallowedTools', DISALLOWED_TOOLS,
    '--max-turns', String(o.maxTurns ?? 40),
  ];
  if (o.model) a.push('--model', o.model);
  if (o.resumeSessionId) a.push('--resume', o.resumeSessionId);
  return a;
}

const quoteWin = (a: string) => `"${a.replace(/"/g, '""')}"`;

export function buildSpawn(command: string, args: string[], platform: NodeJS.Platform) {
  if (platform === 'win32') return { file: [command, ...args].map(quoteWin).join(' '), args: [] as string[], shell: true };
  return { file: command, args, shell: false };
}

export class ClaudeRunner {
  constructor(
    private readonly command: string,
    private readonly prefixArgs: string[] = [],
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  run(o: RunOptions): Promise<RunResult> {
    if (o.signal?.aborted) return Promise.reject(new ClaudeAbortedError('Cancelled'));
    const sp = buildSpawn(this.command, [...this.prefixArgs, ...buildArgs(o)], this.platform);

    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(sp.file, sp.args, { cwd: o.cwd, shell: sp.shell, windowsHide: true, env: this.env });
      } catch (e) {
        reject(new ClaudeNotFoundError(String(e)));
        return;
      }
      let buf = '';
      let stderr = '';
      let sessionId = '';
      let result: { text: string; isError: boolean } | null = null;
      let settled = false;

      const finish = (err?: Error, res?: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(res!);
      };
      const timer = setTimeout(() => {
        killTree(child, this.platform);
        finish(new ClaudeTimeoutError(`Claude did not finish within ${Math.round(o.timeoutMs / 1000)} seconds`));
      }, o.timeoutMs);
      const onAbort = () => {
        killTree(child, this.platform);
        finish(new ClaudeAbortedError('Cancelled'));
      };
      o.signal?.addEventListener('abort', onAbort, { once: true });

      const handleLine = (line: string) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof ev.session_id === 'string') sessionId = ev.session_id;
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) {
            if (b?.type === 'tool_use') o.onProgress?.({ type: 'tool', name: String(b.name), detail: toolDetail(b.input) });
            else if (b?.type === 'text' && b.text) o.onProgress?.({ type: 'text', text: String(b.text) });
          }
        }
        if (ev.type === 'result') {
          result = {
            text: typeof ev.result === 'string' ? ev.result : '',
            isError: ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success'),
          };
        }
      };

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          handleLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (c: string) => {
        stderr = (stderr + c).slice(-4000);
      });
      child.on('error', (e: NodeJS.ErrnoException) =>
        finish(e.code === 'ENOENT' ? new ClaudeNotFoundError(`Could not run "${this.command}"`) : e),
      );
      child.on('close', (code) => {
        if (buf.trim()) handleLine(buf);
        const r = result as { text: string; isError: boolean } | null;
        if (r && !r.isError) return finish(undefined, { text: r.text, sessionId });
        if (code === 127 || code === 9009 || /not recognized|not found|ENOENT/i.test(stderr)) {
          if (!r) return finish(new ClaudeNotFoundError(`Could not run "${this.command}"`));
        }
        finish(new ClaudeRunError(r?.isError ? `Claude reported an error: ${r.text}` : `Claude exited with code ${code}`, code, stderr.slice(-1000)));
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(o.prompt);
    });
  }

  version(): Promise<string | null> {
    const sp = buildSpawn(this.command, [...this.prefixArgs, '--version'], this.platform);
    return new Promise((resolve) => {
      let out = '';
      let child: ChildProcess;
      try {
        child = spawn(sp.file, sp.args, { shell: sp.shell, windowsHide: true, env: this.env });
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        killTree(child, this.platform);
        resolve(null);
      }, 10000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (c: string) => (out += c));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 && out.trim() ? out.trim() : null);
      });
    });
  }
}

function toolDetail(input: any): string {
  if (!input || typeof input !== 'object') return '';
  return String(input.pattern ?? input.file_path ?? input.path ?? input.command ?? '');
}

function killTree(child: ChildProcess, platform: NodeJS.Platform) {
  if (platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/claudeRunner.test.ts`
Expected: PASS. On Windows this exercises the shell path. On macOS/Linux it exercises the direct path. The quoting test covers both.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: run the claude CLI read-only with streaming progress"
```

---

### Task 8: ExplanationStore and ExplainService

**Files:**
- Create: `src/core/explanationStore.ts`, `src/core/explainService.ts`
- Test: `test/unit/explanationStore.test.ts`, `test/unit/explainService.test.ts`

**Interfaces:**
- Consumes: `StoredExplanation` (Task 1); `PROMPT_VERSION`, `parseExplanation`, `extractMermaid`, `setDiagram`, `DiagramKey` (Task 6); `buildExplainPrompt`, `buildJsonRepairPrompt`, `buildDiagramRepairPrompt`, `truncateDiff`, `DIFF_CHAR_LIMIT` (Task 6); `ClaudeRunner.run`, `RunProgress` (Task 7); `GitService.showStat/diff` (Task 3).
- Produces:
  - `repoStoreDir(globalStorageDir: string, repoRoot: string): string`
  - `class ExplanationStore { constructor(dir: string); get(sha): Promise<StoredExplanation | undefined>; put(e: StoredExplanation): Promise<void>; listCachedShas(): Promise<Set<string>> }`
  - `interface ExplainTarget { sha: string; brief: string | null }`
  - `interface ExplainDeps { git: Pick<GitService, 'showStat' | 'diff'>; runner: Pick<ClaudeRunner, 'run'>; store: ExplanationStore; cwd: string; timeoutMs: () => number; model: () => string | undefined; now?: () => Date }`
  - `class ExplanationInvalidError extends Error { raw: string }`
  - `class ExplainService { constructor(d: ExplainDeps); explain(t: ExplainTarget, o?: { force?: boolean; signal?: AbortSignal; onProgress?: (p: RunProgress) => void }): Promise<StoredExplanation>; repairDiagram(sha: string, key: DiagramKey, code: string, error: string, signal?: AbortSignal): Promise<string> }`

- [ ] **Step 1: Write the failing tests**

`test/unit/explanationStore.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../fixtures/explanation.json';
import { ExplanationStore, repoStoreDir } from '../../src/core/explanationStore';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';
import type { StoredExplanation } from '../../src/core/types';

const stored = (sha: string): StoredExplanation => ({
  sha, promptVersion: PROMPT_VERSION, generatedAt: '2026-10-08T15:10:00Z', claudeSessionId: 'sess-1',
  inferred: false, explanation: fixture as unknown as Explanation, thread: [],
});

describe('ExplanationStore', () => {
  it('round-trips, lists shas, and ignores other prompt versions and corrupt files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ed-store-'));
    const store = new ExplanationStore(dir);
    expect(await store.get('aaa')).toBeUndefined();
    await store.put(stored('aaa'));
    expect((await store.get('aaa'))?.claudeSessionId).toBe('sess-1');
    await store.put({ ...stored('bbb'), promptVersion: PROMPT_VERSION + 1 });
    expect(await store.get('bbb')).toBeUndefined();
    writeFileSync(join(dir, 'ccc.json'), '{not json');
    expect(await store.get('ccc')).toBeUndefined();
    expect([...(await store.listCachedShas())]).toEqual(['aaa']);
  });

  it('derives a stable per-repo directory', () => {
    expect(repoStoreDir('/g', 'C:\\Repo\\App')).toBe(repoStoreDir('/g', 'c:/repo/app'));
    expect(repoStoreDir('/g', '/a')).not.toBe(repoStoreDir('/g', '/b'));
  });
});
```

`test/unit/explainService.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../fixtures/explanation.json';
import { ExplanationStore } from '../../src/core/explanationStore';
import { ExplainService, ExplanationInvalidError } from '../../src/core/explainService';
import type { RunOptions, RunResult } from '../../src/core/claudeRunner';

function setup(replies: string[]) {
  const calls: RunOptions[] = [];
  const runner = {
    run: vi.fn(async (o: RunOptions): Promise<RunResult> => {
      calls.push(o);
      o.onProgress?.({ type: 'tool', name: 'Grep', detail: 'x' });
      return { text: replies[Math.min(calls.length - 1, replies.length - 1)], sessionId: `sess-${calls.length}` };
    }),
  };
  const store = new ExplanationStore(mkdtempSync(join(tmpdir(), 'ed-es-')));
  const git = { showStat: async () => 'STAT', diff: async () => 'DIFF' };
  const svc = new ExplainService({
    git, runner, store, cwd: '/repo', timeoutMs: () => 1000, model: () => undefined, now: () => new Date('2026-10-08T15:10:00Z'),
  });
  return { svc, store, calls, runner };
}

const good = JSON.stringify(fixture);

describe('ExplainService.explain', () => {
  it('generates, stores, and then serves from cache', async () => {
    const { svc, store, calls } = setup([good]);
    const progress: string[] = [];
    const r = await svc.explain({ sha: 'abc', brief: 'BRIEF' }, { onProgress: (p) => p.type === 'tool' && progress.push(p.detail) });
    expect(r).toMatchObject({ sha: 'abc', claudeSessionId: 'sess-1', inferred: false, thread: [] });
    expect(calls[0].prompt).toContain('BRIEF');
    expect(calls[0].prompt).toContain('DIFF');
    expect(progress).toEqual(['x']);
    expect(await store.get('abc')).toBeDefined();
    await svc.explain({ sha: 'abc', brief: 'BRIEF' });
    expect(calls).toHaveLength(1);
  });

  it('force regenerates', async () => {
    const { svc, calls } = setup([good]);
    await svc.explain({ sha: 'abc', brief: null });
    await svc.explain({ sha: 'abc', brief: null }, { force: true });
    expect(calls).toHaveLength(2);
  });

  it('marks explanations without a session as inferred', async () => {
    const { svc } = setup([good]);
    const r = await svc.explain({ sha: 'abc', brief: null });
    expect(r.inferred).toBe(true);
    expect(r.explanation.why.inferred).toBe(true);
  });

  it('repairs invalid JSON once by resuming the same Claude session', async () => {
    const { svc, calls } = setup(['Sorry, here: {"summary": 1}', '```json\n' + good + '\n```']);
    const r = await svc.explain({ sha: 'abc', brief: 'B' });
    expect(calls).toHaveLength(2);
    expect(calls[1].resumeSessionId).toBe('sess-1');
    expect(calls[1].prompt).toContain('summary');
    expect(r.claudeSessionId).toBe('sess-2');
  });

  it('gives up after one repair and caches nothing', async () => {
    const { svc, store } = setup(['nope', 'still nope']);
    const err = await svc.explain({ sha: 'abc', brief: 'B' }).catch((e) => e);
    expect(err).toBeInstanceOf(ExplanationInvalidError);
    expect(err.raw).toBe('still nope');
    expect(await store.get('abc')).toBeUndefined();
  });
});

describe('ExplainService.repairDiagram', () => {
  it('asks for one diagram, stores the fixed code, and returns it', async () => {
    const { svc, store, calls } = setup([good, '```mermaid\nflowchart LR\n  A --> B\n```']);
    await svc.explain({ sha: 'abc', brief: 'B' });
    const fixed = await svc.repairDiagram('abc', 'ripple.diagramMermaid', 'flowchart LR\n A(-->B', 'Parse error');
    expect(fixed).toBe('flowchart LR\n  A --> B');
    expect(calls[1].prompt).toContain('Parse error');
    expect(calls[1].maxTurns).toBe(1);
    expect((await store.get('abc'))!.explanation.ripple.diagramMermaid).toBe(fixed);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/unit/explanationStore.test.ts test/unit/explainService.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement** — `src/core/explanationStore.ts`

```ts
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROMPT_VERSION } from './explanationSchema';
import type { StoredExplanation } from './types';

export function repoStoreDir(globalStorageDir: string, repoRoot: string): string {
  const key = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return join(globalStorageDir, 'explanations', createHash('sha1').update(key).digest('hex').slice(0, 16));
}

export class ExplanationStore {
  constructor(private readonly dir: string) {}

  private file(sha: string) {
    return join(this.dir, `${sha}.json`);
  }

  async get(sha: string): Promise<StoredExplanation | undefined> {
    try {
      const data = JSON.parse(await readFile(this.file(sha), 'utf8')) as StoredExplanation;
      return data.promptVersion === PROMPT_VERSION ? data : undefined;
    } catch {
      return undefined;
    }
  }

  async put(e: StoredExplanation): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(e.sha)}.${process.pid}.tmp`;
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
```

- [ ] **Step 4: Implement** — `src/core/explainService.ts`

```ts
import type { ClaudeRunner, RunProgress } from './claudeRunner';
import { PROMPT_VERSION, extractMermaid, parseExplanation, setDiagram, type DiagramKey } from './explanationSchema';
import type { ExplanationStore } from './explanationStore';
import type { GitService } from './gitService';
import { DIFF_CHAR_LIMIT, buildDiagramRepairPrompt, buildExplainPrompt, buildJsonRepairPrompt, truncateDiff } from './prompts';
import type { StoredExplanation } from './types';

export interface ExplainTarget {
  sha: string;
  brief: string | null;
}

export interface ExplainDeps {
  git: Pick<GitService, 'showStat' | 'diff'>;
  runner: Pick<ClaudeRunner, 'run'>;
  store: ExplanationStore;
  cwd: string;
  timeoutMs: () => number;
  model: () => string | undefined;
  now?: () => Date;
}

export class ExplanationInvalidError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
  }
}

export class ExplainService {
  constructor(private readonly d: ExplainDeps) {}

  async explain(
    t: ExplainTarget,
    o: { force?: boolean; signal?: AbortSignal; onProgress?: (p: RunProgress) => void } = {},
  ): Promise<StoredExplanation> {
    if (!o.force) {
      const cached = await this.d.store.get(t.sha);
      if (cached) return cached;
    }
    const [stat, diff] = await Promise.all([this.d.git.showStat(t.sha), this.d.git.diff(t.sha)]);
    const common = { cwd: this.d.cwd, timeoutMs: this.d.timeoutMs(), model: this.d.model(), signal: o.signal, onProgress: o.onProgress };
    const prompt = buildExplainPrompt({ sha: t.sha, brief: t.brief, stat, diff: truncateDiff(diff, DIFF_CHAR_LIMIT) });

    const first = await this.d.runner.run({ ...common, prompt });
    let parsed = parseExplanation(first.text);
    let sessionId = first.sessionId;
    if (!parsed.ok) {
      const second = await this.d.runner.run({ ...common, prompt: buildJsonRepairPrompt(parsed.error), resumeSessionId: first.sessionId });
      parsed = parseExplanation(second.text);
      sessionId = second.sessionId || sessionId;
      if (!parsed.ok) throw new ExplanationInvalidError(`Claude's answer was not a valid explanation: ${parsed.error}`, second.text);
    }

    const explanation = parsed.value;
    if (t.brief === null) explanation.why.inferred = true;
    const stored: StoredExplanation = {
      sha: t.sha,
      promptVersion: PROMPT_VERSION,
      generatedAt: (this.d.now?.() ?? new Date()).toISOString(),
      claudeSessionId: sessionId,
      inferred: t.brief === null,
      explanation,
      thread: [],
    };
    await this.d.store.put(stored);
    return stored;
  }

  async repairDiagram(sha: string, key: DiagramKey, code: string, error: string, signal?: AbortSignal): Promise<string> {
    const stored = await this.d.store.get(sha);
    if (!stored) throw new Error(`No explanation cached for ${sha}`);
    const r = await this.d.runner.run({
      cwd: this.d.cwd, prompt: buildDiagramRepairPrompt(code, error), timeoutMs: this.d.timeoutMs(),
      model: this.d.model(), signal, maxTurns: 1,
    });
    const fixed = extractMermaid(r.text);
    setDiagram(stored.explanation, key, fixed);
    await this.d.store.put(stored);
    return fixed;
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/explanationStore.test.ts test/unit/explainService.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: generate, validate, repair and cache explanations"
```

---

### Task 9: QAService (chat questions, history, fallback, clear)

**Files:**
- Create: `src/core/qaService.ts`
- Test: `test/unit/qaService.test.ts`

**Interfaces:**
- Consumes: `ExplanationStore` (Task 8); `ClaudeRunner.run`, `ClaudeRunError`, `RunProgress` (Task 7); `buildQaPrompt`, `buildQaFallbackPrompt` (Task 6); `QaTurn` (Task 1).
- Produces:
  - `parseSectionPrefix(text: string): { section?: string; question: string }`
  - `interface AskResult { turn: QaTurn; usedFallback: boolean }`
  - `class QAService { constructor(d: { runner: Pick<ClaudeRunner, 'run'>; store: ExplanationStore; cwd: string; timeoutMs: () => number; model: () => string | undefined; now?: () => Date }); ask(sha: string, text: string, o: { brief: string | null; signal?: AbortSignal; onProgress?: (p: RunProgress) => void }): Promise<AskResult>; clear(sha: string): Promise<void> }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixture from '../fixtures/explanation.json';
import { ExplanationStore } from '../../src/core/explanationStore';
import { QAService, parseSectionPrefix } from '../../src/core/qaService';
import { ClaudeRunError, ClaudeTimeoutError, type RunOptions } from '../../src/core/claudeRunner';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';

async function setup(run: (o: RunOptions, n: number) => Promise<{ text: string; sessionId: string }>) {
  const store = new ExplanationStore(mkdtempSync(join(tmpdir(), 'ed-qa-')));
  await store.put({
    sha: 'abc', promptVersion: PROMPT_VERSION, generatedAt: 'g', claudeSessionId: 'sess-explain',
    inferred: false, explanation: fixture as unknown as Explanation, thread: [],
  });
  const calls: RunOptions[] = [];
  const runner = { run: vi.fn(async (o: RunOptions) => { calls.push(o); return run(o, calls.length); }) };
  const qa = new QAService({ runner, store, cwd: '/r', timeoutMs: () => 1000, model: () => undefined, now: () => new Date('2026-10-09T09:00:00Z') });
  return { qa, store, calls };
}

describe('parseSectionPrefix', () => {
  it('splits an About "X": prefix', () => {
    expect(parseSectionPrefix('About "Ripple map": why?')).toEqual({ section: 'Ripple map', question: 'why?' });
    expect(parseSectionPrefix('plain question')).toEqual({ question: 'plain question' });
  });
});

describe('QAService', () => {
  it('resumes the explanation session, records the turn with section and files, and stores the new session id', async () => {
    const { qa, store, calls } = await setup(async (o) => {
      o.onProgress?.({ type: 'tool', name: 'Read', detail: 'src/a.ts' });
      return { text: '  The answer.  ', sessionId: 'sess-2' };
    });
    const r = await qa.ask('abc', 'About "Ripple map": Why only possibly?', { brief: 'B' });
    expect(calls[0].resumeSessionId).toBe('sess-explain');
    expect(calls[0].prompt).toContain('"Ripple map" section');
    expect(r).toEqual({
      usedFallback: false,
      turn: { question: 'Why only possibly?', section: 'Ripple map', answer: 'The answer.', askedAt: '2026-10-09T09:00:00.000Z', filesChecked: ['src/a.ts'] },
    });
    const s = await store.get('abc');
    expect(s!.thread).toHaveLength(1);
    expect(s!.claudeSessionId).toBe('sess-2');
  });

  it('falls back to a fresh run with the explanation and history when resume fails', async () => {
    const { qa, calls } = await setup(async (o, n) => {
      if (n === 1) throw new ClaudeRunError('No conversation found', 1, '');
      return { text: 'Fresh answer', sessionId: 'sess-fresh' };
    });
    const r = await qa.ask('abc', 'Q?', { brief: 'BRIEF' });
    expect(r.usedFallback).toBe(true);
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(calls[1].prompt).toContain('BRIEF');
    expect(calls[1].prompt).toContain('"summary"');
  });

  it('does not fall back on timeouts', async () => {
    const { qa } = await setup(async () => { throw new ClaudeTimeoutError('slow'); });
    await expect(qa.ask('abc', 'Q?', { brief: null })).rejects.toBeInstanceOf(ClaudeTimeoutError);
  });

  it('clear() empties the thread and makes the next question start fresh', async () => {
    const { qa, store, calls } = await setup(async () => ({ text: 'A', sessionId: 'sess-x' }));
    await qa.ask('abc', 'Q1', { brief: null });
    await qa.clear('abc');
    expect((await store.get('abc'))!.thread).toEqual([]);
    const r = await qa.ask('abc', 'Q2', { brief: null });
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(r.usedFallback).toBe(false);
  });

  it('refuses when there is no explanation yet', async () => {
    const { qa } = await setup(async () => ({ text: 'A', sessionId: 's' }));
    await expect(qa.ask('zzz', 'Q', { brief: null })).rejects.toThrow(/No explanation/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/qaService.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/qaService.ts`

```ts
import { ClaudeRunError, type ClaudeRunner, type RunProgress, type RunResult } from './claudeRunner';
import type { ExplanationStore } from './explanationStore';
import { buildQaFallbackPrompt, buildQaPrompt } from './prompts';
import type { QaTurn } from './types';

export function parseSectionPrefix(text: string): { section?: string; question: string } {
  const m = text.match(/^About "([^"]+)":\s*([\s\S]*)$/);
  return m ? { section: m[1], question: m[2].trim() } : { question: text.trim() };
}

export interface AskResult {
  turn: QaTurn;
  usedFallback: boolean;
}

export class QAService {
  constructor(
    private readonly d: {
      runner: Pick<ClaudeRunner, 'run'>;
      store: ExplanationStore;
      cwd: string;
      timeoutMs: () => number;
      model: () => string | undefined;
      now?: () => Date;
    },
  ) {}

  async ask(
    sha: string,
    text: string,
    o: { brief: string | null; signal?: AbortSignal; onProgress?: (p: RunProgress) => void },
  ): Promise<AskResult> {
    const stored = await this.d.store.get(sha);
    if (!stored) throw new Error(`No explanation cached for ${sha}`);
    const { section, question } = parseSectionPrefix(text);
    const files = new Set<string>();
    const onProgress = (p: RunProgress) => {
      if (p.type === 'tool' && p.detail) files.add(p.detail);
      o.onProgress?.(p);
    };
    const common = { cwd: this.d.cwd, timeoutMs: this.d.timeoutMs(), model: this.d.model(), signal: o.signal, onProgress };
    const fresh = () =>
      this.d.runner.run({
        ...common,
        prompt: buildQaFallbackPrompt({ brief: o.brief, explanation: stored.explanation, thread: stored.thread, question, section }),
      });

    let result: RunResult;
    let usedFallback = false;
    if (!stored.claudeSessionId) {
      result = await fresh();
    } else {
      try {
        result = await this.d.runner.run({ ...common, prompt: buildQaPrompt(question, section), resumeSessionId: stored.claudeSessionId });
      } catch (e) {
        if (!(e instanceof ClaudeRunError)) throw e;
        usedFallback = true;
        result = await fresh();
      }
    }

    const turn: QaTurn = {
      question,
      ...(section ? { section } : {}),
      answer: result.text.trim(),
      askedAt: (this.d.now?.() ?? new Date()).toISOString(),
      filesChecked: [...files],
    };
    stored.thread.push(turn);
    if (result.sessionId) stored.claudeSessionId = result.sessionId;
    await this.d.store.put(stored);
    return { turn, usedFallback };
  }

  async clear(sha: string): Promise<void> {
    const stored = await this.d.store.get(sha);
    if (!stored) return;
    stored.thread = [];
    stored.claudeSessionId = '';
    await this.d.store.put(stored);
  }
}
```

Note: `clear()` blanks `claudeSessionId`, so the next question takes the `fresh()` path on purpose. That's why `usedFallback` is `false` for it.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/qaService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: chat questions with per-commit history and resume fallback"
```

---

### Task 10: Markdown export

**Files:**
- Create: `src/core/markdownExport.ts`
- Test: `test/unit/markdownExport.test.ts`

**Interfaces:**
- Consumes: `StoredExplanation` (Task 1).
- Produces: `interface ExportMeta { shortSha: string; subject: string; branch?: string; date: string; sessionTitle?: string }`, `toMarkdown(s: StoredExplanation, meta: ExportMeta): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/explanation.json';
import { toMarkdown } from '../../src/core/markdownExport';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';

describe('toMarkdown', () => {
  const md = toMarkdown(
    {
      sha: 'abc', promptVersion: PROMPT_VERSION, generatedAt: '2026-10-08T15:10:00Z', claudeSessionId: 's', inferred: false,
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/markdownExport.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/markdownExport.ts`

```ts
import type { StoredExplanation } from './types';

export interface ExportMeta {
  shortSha: string;
  subject: string;
  branch?: string;
  date: string;
  sessionTitle?: string;
}

const fence = (code: string) => ['```mermaid', code, '```'].join('\n');

export function toMarkdown(s: StoredExplanation, meta: ExportMeta): string {
  const e = s.explanation;
  const out: string[] = [];
  out.push(`# ${meta.subject} (${meta.shortSha})`, '');
  out.push(
    [
      `Commit: ${meta.shortSha}`,
      meta.branch ? `Branch: ${meta.branch}` : '',
      `Date: ${meta.date}`,
      meta.sessionTitle ? `Session: ${meta.sessionTitle}` : 'Session: none found (reasoning inferred)',
      `Generated: ${s.generatedAt}`,
    ].filter(Boolean).join(' · '),
    '',
  );

  out.push('## 1. In one breath', '', e.summary, '');

  out.push('## 2. Why we did this', '');
  if (e.why.inferred) out.push('_Inferred from the commit message and code; no session transcript was found._', '');
  for (const q of e.why.userQuotes) out.push(`> ${q.text}${q.time ? ` (${q.time})` : ''}`, '');
  out.push(e.why.narrative, '');
  for (const d of e.why.decisions) out.push(`- **${d.kind === 'chosen' ? 'Chosen' : 'Rejected'}:** ${d.choice} — ${d.reason}`);
  out.push('');
  if (e.why.timelineMermaid && !e.why.inferred) out.push(fence(e.why.timelineMermaid), '');

  out.push('## 3. What changed', '');
  e.changes.forEach((c, i) => {
    out.push(`### ${String.fromCharCode(65 + i)}. ${c.title}`, '', `- **Before:** ${c.before}`, `- **After:** ${c.after}`);
    for (const f of c.files) out.push(`- \`${f.path}${f.line ? `:${f.line}` : ''}\` +${f.added} −${f.removed}`);
    out.push('');
  });

  out.push('## 4. How it works now', '', e.howItWorks.narrative, '', fence(e.howItWorks.diagramMermaid), '');

  out.push('## 5. Ripple map: who uses this', '', fence(e.ripple.diagramMermaid), '');
  for (const v of e.ripple.verified) out.push(`- \`${v.path}:${v.line}\` — ${v.role}. ${v.impact}`);
  for (const p of e.ripple.possiblyRelated) out.push(`- _Possibly related:_ \`${p.path}\` — ${p.reason}`);
  out.push('');

  out.push('## 6. What to expect', '', ...e.expectations.effects.map((x) => `- ${x}`), '', '**How to check it yourself**', '');
  out.push(...e.expectations.howToVerify.map((x) => `- ${x}`), '');

  out.push('## 7. Watch-outs', '', ...e.watchOuts.map((w) => `- **${w.kind.toUpperCase()}:** ${w.text}`), '');

  out.push('## 8. Glossary', '', ...e.glossary.map((g) => `- **${g.term}:** ${g.meaning}`), '');

  if (s.thread.length) {
    out.push('## Conversation', '');
    for (const t of s.thread) {
      out.push(`**Q${t.section ? ` (about "${t.section}")` : ''}:** ${t.question}`, '', t.answer, '');
    }
  }
  return out.join('\n');
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/markdownExport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: export explanations and conversations as Markdown"
```

---

### Task 11: Pure webview renderers (explanation, states, chat)

**Files:**
- Create: `src/webview/render.ts`, `src/shared/messages.ts`
- Test: `test/unit/render.test.ts`

**Interfaces:**
- Consumes: `StoredExplanation`, `ChangedFile`, `QaTurn` (Task 1); `DiagramKey` (Task 6).
- Produces:
  - `esc(s: string): string`
  - `rich(s: string): string` (escape, then inline code, then `path:line` links)
  - `interface HeaderInfo { shortSha: string; subject: string; branch?: string; date: string; added: number; removed: number; fileCount: number; sessionTitle?: string; generatedAt?: string; hasTranscript: boolean }`
  - `type ExplainView = { kind: 'loading'; header: HeaderInfo; steps: { label: string; state: 'done' | 'active' | 'todo' }[]; log: string[] } | { kind: 'error'; header: HeaderInfo; variant: 'cliMissing' | 'failed'; message: string; details?: string } | { kind: 'ready'; header: HeaderInfo; stored: StoredExplanation; files: ChangedFile[]; maxDiffTabs: number; failedDiagrams: Record<string, string> }`
  - `renderExplainView(v: ExplainView): string`
  - `SECTION_TITLES: string[]`
  - `interface PendingTurn { question: string; section?: string; partial: string; files: string[] }`
  - `interface ChatView { commit?: { shortSha: string; subject: string }; unavailable?: string; thread: QaTurn[]; pending?: PendingTurn; notice?: string; error?: string }`
  - `renderChatHeader(v: ChatView): string`, `renderChatThread(v: ChatView, now?: Date): string`, `renderAnswer(md: string, keyPrefix: string): string`, `dayLabel(iso: string, now: Date): string`
  - From `messages.ts`: `ExplainToHost`, `ChatToHost`, `HostToWebview` unions.

- [ ] **Step 1: Write the message types** — `src/shared/messages.ts`

```ts
export type ExplainToHost =
  | { type: 'ready' }
  | { type: 'openRef'; path: string; line?: number }
  | { type: 'focusFile'; path: string }
  | { type: 'openAllChanges' }
  | { type: 'openChat' }
  | { type: 'askSection'; section: string }
  | { type: 'regenerate' }
  | { type: 'export' }
  | { type: 'openTranscript' }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'openSettings' }
  | { type: 'diagramError'; key: string; code: string; error: string }
  | { type: 'retryDiagram'; key: string };

export type ChatToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'suggest'; text: string }
  | { type: 'stop' }
  | { type: 'newConversation' }
  | { type: 'openRef'; path: string; line?: number };

export type HostToWebview =
  | { type: 'render'; html: string }
  | { type: 'header'; html: string }
  | { type: 'thread'; html: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'prefill'; text: string };
```

- [ ] **Step 2: Write the failing test** — `test/unit/render.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/explanation.json';
import { esc, rich, renderExplainView, renderChatThread, renderAnswer, dayLabel, type HeaderInfo } from '../../src/webview/render';
import { PROMPT_VERSION, type Explanation } from '../../src/core/explanationSchema';
import type { StoredExplanation } from '../../src/core/types';

const header: HeaderInfo = { shortSha: 'a1c9e42', subject: 'Make <b>handler</b> idempotent', branch: 'feat/x', date: '2026-10-08T14:35:00Z', added: 48, removed: 12, fileCount: 4, sessionTitle: 'Fix', generatedAt: '2026-10-08T15:10:00Z', hasTranscript: true };
const stored = (e: unknown = fixture): StoredExplanation => ({ sha: 'abc', promptVersion: PROMPT_VERSION, generatedAt: 'g', claudeSessionId: 's', inferred: false, explanation: e as Explanation, thread: [] });
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
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run test/unit/render.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement** — `src/webview/render.ts`

```ts
import type { ChangedFile, QaTurn, StoredExplanation } from '../core/types';

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const REF = /(?<![\w/.@:-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]+):(\d+)/g;

function linkRefs(escaped: string): string {
  return escaped.replace(REF, (_m, p: string, l: string) => `<a href="#" class="ref" data-action="openRef" data-path="${p}" data-line="${l}">${p}:${l}</a>`);
}

export function rich(s: string): string {
  return linkRefs(esc(s).replace(/`([^`]+)`/g, '<code>$1</code>'));
}

export interface HeaderInfo {
  shortSha: string;
  subject: string;
  branch?: string;
  date: string;
  added: number;
  removed: number;
  fileCount: number;
  sessionTitle?: string;
  generatedAt?: string;
  hasTranscript: boolean;
}

export type ExplainView =
  | { kind: 'loading'; header: HeaderInfo; steps: { label: string; state: 'done' | 'active' | 'todo' }[]; log: string[] }
  | { kind: 'error'; header: HeaderInfo; variant: 'cliMissing' | 'failed'; message: string; details?: string }
  | { kind: 'ready'; header: HeaderInfo; stored: StoredExplanation; files: ChangedFile[]; maxDiffTabs: number; failedDiagrams: Record<string, string> };

export const SECTION_TITLES = ['In one breath', 'Why we did this', 'What changed', 'How it works now', 'Ripple map', 'What to expect', 'Watch-outs', 'Glossary'];

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function diagram(key: string, code: string, caption: string, failedError?: string): string {
  const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : '';
  if (failedError !== undefined) {
    return `<figure class="diagram failed" data-key="${esc(key)}"><pre class="mermaid-src">${esc(code)}</pre><p class="err">${esc(failedError)}</p><button data-action="retryDiagram" data-key="${esc(key)}">Retry diagram</button>${cap}</figure>`;
  }
  return `<figure class="diagram" data-key="${esc(key)}"><pre class="mermaid-src">${esc(code)}</pre><div class="mermaid-out"></div>${cap}</figure>`;
}

function section(id: string, n: number, title: string, body: string): string {
  return `<section id="${id}" class="sec"><div class="sec-head"><h2>${n} · ${esc(title)}</h2><button class="ask" data-action="askSection" data-section="${esc(title)}" aria-label="Ask about ${esc(title)} in chat">Ask</button></div>${body}</section>`;
}

function renderHeader(h: HeaderInfo, withActions: boolean): string {
  const meta = [
    `<code>${esc(h.shortSha)}</code>`,
    h.branch ? `<span>${esc(h.branch)}</span>` : '',
    `<span>${esc(fmtDate(h.date))}</span>`,
    `<span><span class="add">+${h.added}</span> <span class="del">−${h.removed}</span> in ${h.fileCount} files</span>`,
    h.sessionTitle ? `<span>Session: ${esc(h.sessionTitle)}</span>` : '<span>No session found</span>',
  ].filter(Boolean).join('<span class="dot">·</span>');
  const actions = withActions
    ? `<div class="actions">
<button class="primary" data-action="openAllChanges">Open all changes</button>
<button data-action="openChat">Chat</button>
<button data-action="regenerate">Regenerate</button>
<button data-action="export">Export Markdown</button>
${h.hasTranscript ? '<button data-action="openTranscript">Open session transcript</button>' : ''}
${h.generatedAt ? `<span class="cached">Cached · generated ${esc(fmtDate(h.generatedAt))}</span>` : ''}
</div>
<nav class="chips" aria-label="Sections">${SECTION_TITLES.map((t, i) => `<a href="#s${i + 1}">${esc(t)}</a>`).join('')}</nav>`
    : '';
  return `<header class="hdr"><div class="meta">${meta}</div><h1>${esc(h.subject)}</h1>${actions}</header>`;
}

export function renderExplainView(v: ExplainView): string {
  if (v.kind === 'loading') {
    const steps = v.steps
      .map((s) => `<li class="step ${s.state}"><span class="mark">${s.state === 'done' ? '✓' : s.state === 'active' ? '●' : '○'}</span>${esc(s.label)}</li>`)
      .join('');
    const log = v.log.slice(-8).map((l) => `<div>${esc(l)}</div>`).join('');
    return `${renderHeader(v.header, false)}<div class="state"><h2 class="state-title">Explaining ${esc(v.header.shortSha)}…</h2><ol class="steps">${steps}</ol><div class="log">${log}</div><p class="muted">Usually 30–90 seconds. The diff tabs are ready while you wait.</p><button data-action="cancel">Cancel</button></div>`;
  }
  if (v.kind === 'error') {
    if (v.variant === 'cliMissing') {
      return `${renderHeader(v.header, false)}<div class="state"><h2 class="state-title">Claude Code is needed to write explanations</h2><p>We couldn't run <code>claude</code>. The commit list and diff tabs still work; explanations need the Claude Code CLI installed and signed in.</p><p>${esc(v.message)}</p><a class="button primary" href="https://docs.claude.com/en/docs/claude-code/overview">How to install Claude Code</a> <button data-action="openSettings">Set path to claude in Settings</button></div>`;
    }
    return `${renderHeader(v.header, false)}<div class="state"><h2 class="state-title">The explanation didn't finish</h2><p>${esc(v.message)} Nothing was saved, so trying again is safe.</p>${v.details ? `<details><summary>Technical details</summary><pre>${esc(v.details)}</pre></details>` : ''}<button class="primary" data-action="retry">Try again</button> <button data-action="openAllChanges">Open all changes instead</button></div>`;
  }

  const e = v.stored.explanation;
  const fileByPath = new Map(v.files.map((f) => [f.path, f]));
  const fd = v.failedDiagrams;

  const s1 = `<p class="lead">${rich(e.summary)}</p>`;

  const quotes = e.why.userQuotes
    .map((q) => `<figure class="quote"><blockquote>“${rich(q.text)}”</blockquote><figcaption>You${q.time ? `, ${esc(q.time)}` : ''}</figcaption></figure>`)
    .join('');
  const decisions = e.why.decisions.length
    ? `<h3>Decisions made in the session</h3><div class="grid2">${e.why.decisions
        .map((d) => `<div class="card"><span class="tag ${d.kind}">${d.kind === 'chosen' ? 'CHOSEN' : 'REJECTED'}</span><div>${rich(d.choice)}</div><div class="muted">${rich(d.reason)}</div></div>`)
        .join('')}</div>`
    : '';
  const timeline =
    e.why.timelineMermaid && !e.why.inferred
      ? diagram('why.timelineMermaid', e.why.timelineMermaid, 'Timeline of the session leading up to this commit', fd['why.timelineMermaid'])
      : '';
  const s2 = `${e.why.inferred ? '<p><span class="tag inferred">INFERRED</span> <span class="muted">No session transcript was found. This is a best guess from the commit message and code.</span></p>' : ''}${quotes}<p>${rich(e.why.narrative)}</p>${decisions}${timeline}`;

  const chip = (path: string, line?: number) => {
    const f = fileByPath.get(path);
    const stats = f && !f.binary ? ` <span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>` : '';
    return `<a href="#" class="chip" data-action="focusFile" data-path="${esc(path)}"><code>${esc(path)}${line ? `:${line}` : ''}</code>${stats}</a>`;
  };
  const changes = e.changes
    .map(
      (c, i) =>
        `<div class="card"><h3>${String.fromCharCode(65 + i)}. ${rich(c.title)}</h3><div class="grid2"><div class="ba"><span class="tag">BEFORE</span><div>${rich(c.before)}</div></div><div class="ba"><span class="tag chosen">AFTER</span><div>${rich(c.after)}</div></div></div><div class="chips-row">${c.files.map((f) => chip(f.path, f.line)).join('')}</div></div>`,
    )
    .join('');
  const binary = v.files.filter((f) => f.binary);
  const textFiles = v.files.filter((f) => !f.binary);
  const binaryNote = binary.length ? `<p class="muted">Binary files (no diff tab): ${binary.map((f) => `<code>${esc(f.path)}</code> binary`).join(', ')}</p>` : '';
  const overflow = textFiles.length > v.maxDiffTabs ? `<button class="primary" data-action="openAllChanges">Open all ${textFiles.length} changes</button>` : '';
  const s3 = `${changes}${binaryNote}${overflow}`;

  const s4 = `<p>${rich(e.howItWorks.narrative)}</p>${diagram('howItWorks.diagramMermaid', e.howItWorks.diagramMermaid, 'How it works after this commit', fd['howItWorks.diagramMermaid'])}`;

  const verified = e.ripple.verified
    .map((r) => `<li><a href="#" class="ref" data-action="openRef" data-path="${esc(r.path)}" data-line="${r.line}"><code>${esc(r.path)}:${r.line}</code></a> ${rich(r.role)}. ${rich(r.impact)}</li>`)
    .join('');
  const possibly = e.ripple.possiblyRelated
    .map((r) => `<li class="muted"><code>${esc(r.path)}</code> Possibly related: ${rich(r.reason)}</li>`)
    .join('');
  const s5 = `${diagram('ripple.diagramMermaid', e.ripple.diagramMermaid, 'Solid: verified by search · Dotted: possibly related, not verified', fd['ripple.diagramMermaid'])}<ul class="ripple">${verified}${possibly}</ul>`;

  const s6 = `<ul>${e.expectations.effects.map((x) => `<li>${rich(x)}</li>`).join('')}</ul><div class="card"><h3>How to check it yourself</h3><ul>${e.expectations.howToVerify.map((x) => `<li>${rich(x)}</li>`).join('')}</ul></div>`;

  const s7 = `<ul class="watch">${e.watchOuts.map((w) => `<li><span class="tag ${esc(w.kind)}">${esc(w.kind.toUpperCase())}</span> ${rich(w.text)}</li>`).join('')}</ul>`;

  const s8 = `<dl class="glossary">${e.glossary.map((g) => `<div><dt>${esc(g.term)}</dt><dd>${rich(g.meaning)}</dd></div>`).join('')}</dl>`;

  const bodies = [s1, s2, s3, s4, s5, s6, s7, s8];
  const sections = SECTION_TITLES.map((t, i) => section(`s${i + 1}`, i + 1, t, bodies[i])).join('');
  return `${renderHeader(v.header, true)}${sections}<footer class="muted">Written by Claude Code from ${v.header.sessionTitle ? `the session “${esc(v.header.sessionTitle)}”` : 'the commit'} and the commit diff. File references link to the code they describe.</footer>`;
}

// ---------- chat ----------

export interface PendingTurn {
  question: string;
  section?: string;
  partial: string;
  files: string[];
}

export interface ChatView {
  commit?: { shortSha: string; subject: string };
  unavailable?: string;
  thread: QaTurn[];
  pending?: PendingTurn;
  notice?: string;
  error?: string;
}

const SUGGESTIONS = ['What breaks if I revert this?', "Explain it like I'm new here", 'How would I test this?'];

export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (key(d) === key(now)) return 'Today';
  if (key(d) === key(yesterday)) return `Yesterday · ${md}`;
  return md;
}

export function renderAnswer(md: string, keyPrefix: string): string {
  const out: string[] = [];
  let diagramN = 0;
  const parts = md.split(/```(\w*)\n([\s\S]*?)```/);
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i];
    for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
      const lines = para.split('\n');
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        out.push(`<ul>${lines.map((l) => `<li>${rich(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`);
      } else {
        out.push(`<p>${lines.map((l) => rich(l.replace(/^#+\s*/, ''))).join('<br>')}</p>`);
      }
    }
    if (i + 2 < parts.length) {
      const lang = parts[i + 1];
      const code = parts[i + 2].replace(/\n$/, '');
      out.push(lang === 'mermaid' ? diagram(`${keyPrefix}-${diagramN++}`, code, '') : `<pre><code>${esc(code)}</code></pre>`);
    }
  }
  return out.join('');
}

export function renderChatHeader(v: ChatView): string {
  if (!v.commit) return '<div class="chat-hdr"><span class="label">CHAT</span><span class="muted">Select a commit to start.</span></div>';
  return `<div class="chat-hdr"><div class="who"><span class="label">CHATTING ABOUT</span><span class="title"><code>${esc(v.commit.shortSha)}</code> ${esc(v.commit.subject)}</span><span class="muted">Knows the session, the explanation and the code (read-only)</span></div><button data-action="newConversation">New conversation</button></div>`;
}

function question(q: string, section?: string): string {
  return `<div class="msg me">${section ? `<span class="about">About “${esc(section)}”</span><br>` : ''}${esc(q)}</div>`;
}

export function renderChatThread(v: ChatView, now: Date = new Date()): string {
  if (v.unavailable) return `<p class="muted center">${esc(v.unavailable)}</p>`;
  const out: string[] = [];
  let lastDay = '';
  v.thread.forEach((t, i) => {
    const day = dayLabel(t.askedAt, now);
    if (day !== lastDay) {
      out.push(`<div class="day"><span>${esc(day)}</span></div>`);
      lastDay = day;
    }
    out.push(question(t.question, t.section));
    const files = t.filesChecked.length ? `<div class="files">Checked: ${t.filesChecked.map(esc).join(', ')}</div>` : '';
    out.push(`<div class="msg claude">${renderAnswer(t.answer, `qa-${i}`)}${files}</div>`);
  });
  if (v.pending) {
    if (lastDay !== 'Today') out.push('<div class="day"><span>Today</span></div>');
    out.push(question(v.pending.question, v.pending.section));
    const files = v.pending.files.length ? `<div class="files">Checking: ${v.pending.files.map(esc).join(', ')}</div>` : '';
    out.push(`<div class="msg claude pending">${v.pending.partial ? renderAnswer(v.pending.partial, 'qa-pending') : '<p class="muted">Thinking…</p>'}${files}</div>`);
  }
  if (v.notice) out.push(`<p class="notice">${esc(v.notice)}</p>`);
  if (v.error) out.push(`<p class="error">${esc(v.error)}</p>`);
  const suggestions = (v.thread.length ? SUGGESTIONS.slice(0, 2) : SUGGESTIONS)
    .map((s) => `<button class="suggest" data-action="suggest" data-text="${esc(s)}">${esc(s)}</button>`)
    .join('');
  if (!v.pending) out.push(`<div class="suggestions">${suggestions}</div>`);
  return out.join('');
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/unit/render.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: safe HTML renderers for explanation, states and chat"
```

---

### Task 12: Tree model, sidebar view and extension activation

**Files:**
- Create: `src/core/treeModel.ts`, `src/vscode/commitsTree.ts`, `src/vscode/extension.ts`, `esbuild.mjs`, `media/icon.svg`, `.vscodeignore`, `.vscode/launch.json`
- Modify: `package.json` (contributes, scripts, devDependencies)
- Test: `test/unit/treeModel.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 and 7–9 (`findTranscriptFiles`, `parseTranscriptFile`, `linkCommits`, `GitService`, `ClaudeRunner`, `ExplanationStore`, `repoStoreDir`, `ExplainService`, `QAService`).
- Produces:
  - `src/core/treeModel.ts`:
    - `type CommitNode = { kind: 'commit'; id: string; label: string; description: string; tooltip: string; sha: string; linked: LinkedCommit; group: SessionGroup | null; cached: boolean }`
    - `type SessionNode = { kind: 'session'; id: string; label: string; description: string; tooltip: string; group: SessionGroup; children: CommitNode[] }`
    - `type OtherNode = { kind: 'other'; id: 'other'; label: string; description: string; children: CommitNode[] }`
    - `type RootNode = SessionNode | OtherNode`
    - `buildTree(link: LinkResult, cached: Set<string>, filter?: string): RootNode[]`
  - `src/vscode/commitsTree.ts`: `class CommitsTreeProvider implements vscode.TreeDataProvider<RootNode | CommitNode>` with `update(link: LinkResult, cached: Set<string>)`, `setFilter(q: string)`, `markCached(sha: string)`, `getChildren()`, `getTreeItem()`.
  - `src/vscode/extension.ts`: `activate(context): Promise<ExplainDiffApi>`, where `interface ExplainDiffApi { tree: CommitsTreeProvider; store: ExplanationStore; refresh(): Promise<void>; controller: Controller | undefined }`. `Controller` arrives in Task 13; until then this task exports `controller: undefined`.

- [ ] **Step 1: Write the failing test** — `test/unit/treeModel.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildTree } from '../../src/core/treeModel';
import type { CommitInfo, LinkResult, Session } from '../../src/core/types';

const commit = (sha: string, subject: string, date: string): CommitInfo => ({ sha, shortSha: sha.slice(0, 7), subject, body: '', authorDate: date, claudeCoAuthored: true });
const session = (id: string, title: string, start: string, edited: string[] = []): Session => ({ id, title, branch: 'feat/x', start, end: start, events: [], editedFiles: edited, filePath: `/${id}.jsonl` });

const link: LinkResult = {
  groups: [
    { session: session('s2', 'Dashboard filter', '2026-10-07T09:40:00Z', ['src/dash.ts']), commits: [{ commit: commit('2222222aaa', 'Add date filter', '2026-10-07T10:00:00Z'), eventIndex: 3, via: 'transcript' }] },
    { session: session('s1', 'Fix webhook', '2026-10-08T14:02:00Z'), commits: [
      { commit: commit('a1c9e42aaa', 'Make handler idempotent', '2026-10-08T14:35:00Z'), eventIndex: 5, via: 'transcript' },
      { commit: commit('7f03b11aaa', 'Retry with backoff', '2026-10-08T14:50:00Z'), eventIndex: 9, via: 'trailer' },
    ] },
  ],
  other: [{ commit: commit('cccccccaaa', 'Orphan', '2026-10-01T00:00:00Z'), eventIndex: null, via: 'none' }],
};

describe('buildTree', () => {
  it('lists sessions newest first, then other commits, with cached flags', () => {
    const t = buildTree(link, new Set(['a1c9e42aaa']));
    expect(t.map((n) => n.label)).toEqual(['Fix webhook', 'Dashboard filter', 'Other Claude commits']);
    const s1 = t[0] as Extract<typeof t[number], { kind: 'session' }>;
    expect(s1.description).toContain('feat/x');
    expect(s1.description).toContain('2 commits');
    expect(s1.children.map((c) => [c.label, c.cached])).toEqual([['a1c9e42 Make handler idempotent', true], ['7f03b11 Retry with backoff', false]]);
    expect(s1.children[0].group?.session.id).toBe('s1');
    expect(t[2].children[0].group).toBeNull();
  });

  it('filters by message, sha, session title and session files', () => {
    expect(buildTree(link, new Set(), 'backoff').flatMap((n) => n.children.map((c) => c.sha))).toEqual(['7f03b11aaa']);
    expect(buildTree(link, new Set(), 'a1c9').flatMap((n) => n.children.map((c) => c.sha))).toEqual(['a1c9e42aaa']);
    expect(buildTree(link, new Set(), 'webhook').flatMap((n) => n.children)).toHaveLength(2);
    expect(buildTree(link, new Set(), 'dash.ts').map((n) => n.label)).toEqual(['Dashboard filter']);
  });

  it('omits the other group when empty', () => {
    expect(buildTree({ groups: [], other: [] }, new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/treeModel.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/treeModel.ts`

```ts
import type { LinkResult, LinkedCommit, SessionGroup } from './types';

export type CommitNode = {
  kind: 'commit'; id: string; label: string; description: string; tooltip: string;
  sha: string; linked: LinkedCommit; group: SessionGroup | null; cached: boolean;
};
export type SessionNode = { kind: 'session'; id: string; label: string; description: string; tooltip: string; group: SessionGroup; children: CommitNode[] };
export type OtherNode = { kind: 'other'; id: 'other'; label: string; description: string; children: CommitNode[] };
export type RootNode = SessionNode | OtherNode;

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const plural = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

function commitNode(l: LinkedCommit, group: SessionGroup | null, cached: Set<string>): CommitNode {
  const c = l.commit;
  return {
    kind: 'commit',
    id: `commit:${c.sha}`,
    label: `${c.shortSha} ${c.subject}`,
    description: cached.has(c.sha) ? 'explained' : '',
    tooltip: `${c.subject}\n${c.shortSha} · ${fmt(c.authorDate)}${l.via === 'trailer' ? '\nLinked by co-author line and time' : ''}`,
    sha: c.sha,
    linked: l,
    group,
    cached: cached.has(c.sha),
  };
}

export function buildTree(link: LinkResult, cached: Set<string>, filter = ''): RootNode[] {
  const q = filter.trim().toLowerCase();
  const commitMatches = (l: LinkedCommit) =>
    !q || l.commit.subject.toLowerCase().includes(q) || l.commit.body.toLowerCase().includes(q) || l.commit.sha.startsWith(q);

  const roots: RootNode[] = [];
  const groups = [...link.groups].sort((a, b) => b.session.start.localeCompare(a.session.start));
  for (const g of groups) {
    const s = g.session;
    const sessionMatches = !!q && (s.title.toLowerCase().includes(q) || s.editedFiles.some((f) => f.toLowerCase().includes(q)));
    const commits = g.commits.filter((l) => sessionMatches || commitMatches(l));
    if (!commits.length) continue;
    roots.push({
      kind: 'session',
      id: `session:${s.id}`,
      label: s.title,
      description: `${s.branch ?? 'no branch'} · ${fmt(s.start)} · ${plural(g.commits.length)}`,
      tooltip: `${s.title}\n${s.filePath}`,
      group: g,
      children: commits.map((l) => commitNode(l, g, cached)),
    });
  }
  const others = link.other.filter(commitMatches);
  if (others.length) {
    roots.push({ kind: 'other', id: 'other', label: 'Other Claude commits', description: `no session transcript found · ${plural(others.length)}`, children: others.map((l) => commitNode(l, null, cached)) });
  }
  return roots;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/unit/treeModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Add build tooling and the manifest**

Run:

```bash
npm install -D esbuild @vscode/vsce @vscode/test-cli @vscode/test-electron
npm install mermaid@11
```

`esbuild.mjs` (the webview entry files get created as stubs in Step 7, so every entry exists):

```js
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const configs = [
  { entryPoints: ['src/vscode/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], outfile: 'dist/extension.js', sourcemap: true },
  { entryPoints: ['src/webview/explainMain.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2020', outfile: 'dist/explain.js', sourcemap: true },
  { entryPoints: ['src/webview/chatMain.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'es2020', outfile: 'dist/chat.js', sourcemap: true },
];
if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
```

`media/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M17 5l2-2M19 7h2"/></svg>
```

`.vscodeignore`:

```
src/**
test/**
docs/**
node_modules/**
.vscode-test/**
**/*.map
tsconfig.json
vitest.config.ts
esbuild.mjs
.vscode-test.mjs
```

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

Merge into `package.json`. Keep the existing fields and add or replace these:

```json
{
  "activationEvents": [],
  "contributes": {
    "viewsContainers": { "activitybar": [{ "id": "explainDiff", "title": "Claude Commits", "icon": "media/icon.svg" }] },
    "views": { "explainDiff": [{ "id": "explainDiff.commits", "name": "Claude Commits" }] },
    "commands": [
      { "command": "explainDiff.refresh", "title": "Refresh", "icon": "$(refresh)", "category": "Explain Diff" },
      { "command": "explainDiff.filter", "title": "Filter Commits", "icon": "$(filter)", "category": "Explain Diff" },
      { "command": "explainDiff.openCommit", "title": "Explain Commit", "category": "Explain Diff" }
    ],
    "menus": {
      "view/title": [
        { "command": "explainDiff.filter", "when": "view == explainDiff.commits", "group": "navigation@1" },
        { "command": "explainDiff.refresh", "when": "view == explainDiff.commits", "group": "navigation@2" }
      ],
      "commandPalette": [{ "command": "explainDiff.openCommit", "when": "false" }]
    },
    "configuration": {
      "title": "Explain Diff",
      "properties": {
        "explainDiff.claudePath": { "type": "string", "default": "claude", "description": "Path to the Claude Code CLI." },
        "explainDiff.timeoutSeconds": { "type": "number", "default": 180, "minimum": 30, "description": "Maximum time for one explanation or answer." },
        "explainDiff.model": { "type": "string", "default": "", "description": "Model passed to claude --model. Empty uses the CLI default." },
        "explainDiff.briefTokenBudget": { "type": "number", "default": 30000, "minimum": 2000, "description": "Approximate size of the session context sent to Claude." },
        "explainDiff.maxDiffTabs": { "type": "number", "default": 20, "minimum": 0, "description": "Maximum number of per-file diff tabs opened for a commit." }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "test:smoke": "npm run build && node test/smoke/makeFixture.mjs && vscode-test",
    "package": "npm run build && vsce package --no-dependencies"
  }
}
```

- [ ] **Step 6: Implement the tree provider** — `src/vscode/commitsTree.ts`

```ts
import * as vscode from 'vscode';
import { buildTree, type CommitNode, type RootNode } from '../core/treeModel';
import type { LinkResult } from '../core/types';

type Node = RootNode | CommitNode;

export class CommitsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private link: LinkResult = { groups: [], other: [] };
  private cached = new Set<string>();
  private filter = '';
  private roots: RootNode[] = [];

  update(link: LinkResult, cached: Set<string>) {
    this.link = link;
    this.cached = cached;
    this.rebuild();
  }

  setFilter(q: string) {
    this.filter = q;
    this.rebuild();
  }

  get filterText() {
    return this.filter;
  }

  markCached(sha: string) {
    this.cached.add(sha);
    this.rebuild();
  }

  private rebuild() {
    this.roots = buildTree(this.link, this.cached, this.filter);
    this.emitter.fire(undefined);
  }

  getChildren(element?: Node): Node[] {
    if (!element) return this.roots;
    return element.kind === 'commit' ? [] : element.children;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'commit') {
      const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
      item.id = n.id;
      item.description = n.description;
      item.tooltip = n.tooltip;
      item.iconPath = new vscode.ThemeIcon(n.cached ? 'circle-filled' : 'circle-outline', n.cached ? new vscode.ThemeColor('charts.green') : undefined);
      item.command = { command: 'explainDiff.openCommit', title: 'Explain Commit', arguments: [n] };
      item.contextValue = 'commit';
      return item;
    }
    const item = new vscode.TreeItem(n.label, n === this.roots[0] ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = n.id;
    item.description = n.description;
    if (n.kind === 'session') item.tooltip = n.tooltip;
    item.iconPath = new vscode.ThemeIcon(n.kind === 'session' ? 'comment-discussion' : 'question');
    return item;
  }
}
```

- [ ] **Step 7: Implement activation** — `src/vscode/extension.ts`. Also create placeholder webview entries so esbuild has every input. Tasks 14 and 15 replace them.

`src/webview/explainMain.ts` and `src/webview/chatMain.ts` (temporary, both files):

```ts
export {};
```

`src/vscode/extension.ts`:

```ts
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { ClaudeRunner } from '../core/claudeRunner';
import { linkCommits } from '../core/commitLinker';
import { ExplainService } from '../core/explainService';
import { ExplanationStore, repoStoreDir } from '../core/explanationStore';
import { GitService } from '../core/gitService';
import { QAService } from '../core/qaService';
import { findTranscriptFiles } from '../core/sessionLocator';
import { parseTranscriptFile } from '../core/transcriptParser';
import type { Session } from '../core/types';
import { CommitsTreeProvider } from './commitsTree';

export interface ExplainDiffApi {
  tree: CommitsTreeProvider;
  store: ExplanationStore;
  refresh(): Promise<void>;
  controller: unknown;
}

export const config = () => {
  const c = vscode.workspace.getConfiguration('explainDiff');
  return {
    claudePath: c.get<string>('claudePath', 'claude'),
    timeoutMs: c.get<number>('timeoutSeconds', 180) * 1000,
    model: c.get<string>('model', '') || undefined,
    briefTokenBudget: c.get<number>('briefTokenBudget', 30000),
    maxDiffTabs: c.get<number>('maxDiffTabs', 20),
  };
};

export async function activate(context: vscode.ExtensionContext): Promise<ExplainDiffApi> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const tree = new CommitsTreeProvider();
  const view = vscode.window.createTreeView('explainDiff.commits', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view);

  const cwd = folder?.uri.fsPath ?? homedir();
  const git = new GitService(cwd);
  const repoRoot = (await git.repoRoot()) ?? cwd;
  const store = new ExplanationStore(repoStoreDir(context.globalStorageUri.fsPath, repoRoot));
  const runner = () => new ClaudeRunner(config().claudePath);
  const explain = new ExplainService({ git, runner: { run: (o) => runner().run(o) }, store, cwd: repoRoot, timeoutMs: () => config().timeoutMs, model: () => config().model });
  const qa = new QAService({ runner: { run: (o) => runner().run(o) }, store, cwd: repoRoot, timeoutMs: () => config().timeoutMs, model: () => config().model });
  const projectsDir = process.env.EXPLAIN_DIFF_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
  const sessionCache = new Map<string, { mtimeMs: number; session: Session }>();
  let cliVersion: string | null | undefined;

  const refresh = async () => {
    if (!folder || !(await git.repoRoot())) {
      tree.update({ groups: [], other: [] }, new Set());
      view.message = 'Open a git repository to see Claude commits.';
      return;
    }
    const files = await findTranscriptFiles(projectsDir, [repoRoot, folder.uri.fsPath]);
    const sessions: Session[] = [];
    for (const f of files) {
      try {
        const { mtimeMs } = await stat(f);
        const hit = sessionCache.get(f);
        if (hit && hit.mtimeMs === mtimeMs) {
          sessions.push(hit.session);
          continue;
        }
        const session = await parseTranscriptFile(f);
        sessionCache.set(f, { mtimeMs, session });
        sessions.push(session);
      } catch {
        // unreadable transcript: skip it
      }
    }
    const link = await linkCommits(sessions, git);
    tree.update(link, await store.listCachedShas());
    if (cliVersion === undefined) cliVersion = await runner().version();
    const cli = cliVersion ? `claude CLI ${cliVersion}` : 'claude CLI not found, explanations unavailable';
    view.message = link.groups.length || link.other.length
      ? `${cli} · ${sessions.length} sessions scanned`
      : `No Claude Code sessions found for this folder (looked in ${projectsDir}). ${cli}`;
  };

  let timer: NodeJS.Timeout | undefined;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 2000);
  };
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/{HEAD,refs/**}'));
    watcher.onDidChange(debounced);
    watcher.onDidCreate(debounced);
    watcher.onDidDelete(debounced);
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('explainDiff.refresh', () => refresh()),
    vscode.commands.registerCommand('explainDiff.filter', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'Filter by commit message, SHA, session title or edited file', value: tree.filterText });
      if (q !== undefined) tree.setFilter(q);
    }),
    vscode.commands.registerCommand('explainDiff.openCommit', () => {
      vscode.window.showInformationMessage('Explanations arrive in the next task.');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('explainDiff.claudePath')) {
        cliVersion = undefined;
        void refresh();
      }
    }),
  );

  void explain;
  void qa;
  await refresh();
  return { tree, store, refresh, controller: undefined };
}

export function deactivate() {}
```

- [ ] **Step 8: Build and typecheck**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: no type errors; `dist/extension.js`, `dist/explain.js`, `dist/chat.js` written; all unit tests PASS.

- [ ] **Step 9: Manual check**

Open this folder in VS Code and press F5 ("Run Extension"). In the Extension Development Host, open a repo that has Claude sessions. The "Claude Commits" activity-bar view should list sessions with their commits, and the view message should show the CLI version. Clicking a commit should show "Explanations arrive in the next task."

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: sidebar of Claude commits grouped by session"
```

---

### Task 13: Commit tab set (diff tabs) and the controller

**Files:**
- Create: `src/core/tabPlan.ts`, `src/vscode/commitTabs.ts`, `src/vscode/controller.ts`
- Modify: `src/vscode/extension.ts` (wire the controller and register the content provider)
- Test: `test/unit/tabPlan.test.ts`

**Interfaces:**
- Consumes: `ChangedFile` (Task 1); `GitService.changedFiles/fileAt` (Task 3); `buildBrief` (Task 5); `CommitNode` (Task 12).
- Produces:
  - `src/core/tabPlan.ts`:
    - `interface DiffTabSpec { path: string; leftRef: string | null; leftPath: string; rightRef: string | null; rightPath: string; title: string }`
    - `planDiffTabs(sha: string, shortSha: string, files: ChangedFile[], max: number): { tabs: DiffTabSpec[]; overflow: number; binary: string[] }`
    - `diffTabFor(sha: string, shortSha: string, file: ChangedFile): DiffTabSpec`
  - `src/vscode/commitTabs.ts`:
    - `DIFF_SCHEME = 'explain-diff'`
    - `class GitContentProvider implements vscode.TextDocumentContentProvider`
    - `class CommitTabs { constructor(repoRoot: string); open(sha, shortSha, files, max): Promise<void>; focusFile(sha, shortSha, file): Promise<void>; closeFor(sha): Promise<void>; openAll(sha, shortSha, files): Promise<void> }`
  - `src/vscode/controller.ts`:
    - `interface CommitContext { linked: LinkedCommit; group: SessionGroup | null; brief: string | null; files: ChangedFile[]; repoRoot: string }`
    - `class Controller { currentSha?: string; openCommit(node: CommitNode): Promise<void> }`. Task 13 opens only the diff tabs; Tasks 14 and 15 add the explanation and chat panels through the hooks `onOpen` and `onClose`.

- [ ] **Step 1: Write the failing test** — `test/unit/tabPlan.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { planDiffTabs } from '../../src/core/tabPlan';
import type { ChangedFile } from '../../src/core/types';

const f = (status: ChangedFile['status'], path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ status, path, added: 1, removed: 1, binary: false, ...extra });

describe('planDiffTabs', () => {
  const sha = 'a1c9e42fff';
  it('maps statuses to left/right refs and titles', () => {
    const { tabs } = planDiffTabs(sha, 'a1c9e42', [
      f('M', 'src/webhooks/handler.ts'),
      f('A', 'db/0042.sql'),
      f('D', 'old.ts'),
      f('R', 'src/new.ts', { oldPath: 'src/old.ts' }),
    ], 20);
    expect(tabs).toEqual([
      { path: 'src/webhooks/handler.ts', leftRef: `${sha}^`, leftPath: 'src/webhooks/handler.ts', rightRef: sha, rightPath: 'src/webhooks/handler.ts', title: 'handler.ts · M · a1c9e42' },
      { path: 'db/0042.sql', leftRef: null, leftPath: 'db/0042.sql', rightRef: sha, rightPath: 'db/0042.sql', title: '0042.sql · A · a1c9e42' },
      { path: 'old.ts', leftRef: `${sha}^`, leftPath: 'old.ts', rightRef: null, rightPath: 'old.ts', title: 'old.ts · D · a1c9e42' },
      { path: 'src/new.ts', leftRef: `${sha}^`, leftPath: 'src/old.ts', rightRef: sha, rightPath: 'src/new.ts', title: 'new.ts · R · a1c9e42' },
    ]);
  });

  it('skips binary files and caps the number of tabs', () => {
    const files = [f('A', 'logo.png', { binary: true, added: null, removed: null }), ...Array.from({ length: 5 }, (_, i) => f('M', `f${i}.ts`))];
    const r = planDiffTabs(sha, 'a1c9e42', files, 3);
    expect(r.tabs.map((t) => t.path)).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(r.overflow).toBe(2);
    expect(r.binary).toEqual(['logo.png']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/unit/tabPlan.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `src/core/tabPlan.ts`

```ts
import type { ChangedFile } from './types';

export interface DiffTabSpec {
  path: string;
  leftRef: string | null;
  leftPath: string;
  rightRef: string | null;
  rightPath: string;
  title: string;
}

export function diffTabFor(sha: string, shortSha: string, file: ChangedFile): DiffTabSpec {
  const name = file.path.split('/').pop() ?? file.path;
  return {
    path: file.path,
    leftRef: file.status === 'A' ? null : `${sha}^`,
    leftPath: file.oldPath ?? file.path,
    rightRef: file.status === 'D' ? null : sha,
    rightPath: file.path,
    title: `${name} · ${file.status} · ${shortSha}`,
  };
}

export function planDiffTabs(sha: string, shortSha: string, files: ChangedFile[], max: number) {
  const text = files.filter((f) => !f.binary);
  return {
    tabs: text.slice(0, Math.max(0, max)).map((f) => diffTabFor(sha, shortSha, f)),
    overflow: Math.max(0, text.length - Math.max(0, max)),
    binary: files.filter((f) => f.binary).map((f) => f.path),
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/unit/tabPlan.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the tab glue** — `src/vscode/commitTabs.ts`

```ts
import * as vscode from 'vscode';
import { GitService } from '../core/gitService';
import { diffTabFor, planDiffTabs, type DiffTabSpec } from '../core/tabPlan';
import type { ChangedFile } from '../core/types';

export const DIFF_SCHEME = 'explain-diff';

function gitUri(repoRoot: string, commit: string, ref: string | null, path: string): vscode.Uri {
  const query = new URLSearchParams({ repo: repoRoot, commit, ref: ref ?? '' }).toString();
  return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${path}`, query });
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const ref = q.get('ref');
    const repo = q.get('repo');
    if (!ref || !repo) return '';
    return new GitService(repo).fileAt(ref, uri.path.replace(/^\//, ''));
  }
}

export class CommitTabs {
  constructor(private readonly repoRoot: string) {}

  private async openSpec(sha: string, spec: DiffTabSpec, focus: boolean) {
    const left = gitUri(this.repoRoot, sha, spec.leftRef, spec.leftPath);
    const right = gitUri(this.repoRoot, sha, spec.rightRef, spec.rightPath);
    await vscode.commands.executeCommand('vscode.diff', left, right, spec.title, {
      preview: false,
      preserveFocus: !focus,
      viewColumn: vscode.ViewColumn.One,
    });
  }

  async open(sha: string, shortSha: string, files: ChangedFile[], max: number): Promise<void> {
    for (const spec of planDiffTabs(sha, shortSha, files, max).tabs) await this.openSpec(sha, spec, false);
  }

  async focusFile(sha: string, shortSha: string, file: ChangedFile): Promise<void> {
    await this.openSpec(sha, diffTabFor(sha, shortSha, file), true);
  }

  async closeFor(sha: string): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => {
        const input = t.input;
        if (!(input instanceof vscode.TabInputTextDiff)) return false;
        return input.modified.scheme === DIFF_SCHEME && new URLSearchParams(input.modified.query).get('commit') === sha;
      });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  async openAll(sha: string, shortSha: string, files: ChangedFile[]): Promise<void> {
    const resources = files
      .filter((f) => !f.binary)
      .map((f) => {
        const spec = diffTabFor(sha, shortSha, f);
        return [
          vscode.Uri.file(`${this.repoRoot}/${f.path}`),
          gitUri(this.repoRoot, sha, spec.leftRef, spec.leftPath),
          gitUri(this.repoRoot, sha, spec.rightRef, spec.rightPath),
        ];
      });
    await vscode.commands.executeCommand('vscode.changes', `Changes in ${shortSha}`, resources);
  }
}
```

- [ ] **Step 6: Implement the controller** — `src/vscode/controller.ts`

```ts
import * as vscode from 'vscode';
import { buildBrief } from '../core/briefBuilder';
import type { GitService } from '../core/gitService';
import type { CommitNode } from '../core/treeModel';
import type { ChangedFile, LinkedCommit, SessionGroup } from '../core/types';
import type { CommitTabs } from './commitTabs';

export interface CommitContext {
  linked: LinkedCommit;
  group: SessionGroup | null;
  brief: string | null;
  files: ChangedFile[];
  repoRoot: string;
}

export interface ControllerHooks {
  onOpen?: (ctx: CommitContext) => void | Promise<void>;
  onClose?: (sha: string) => void | Promise<void>;
}

export class Controller {
  currentSha?: string;
  current?: CommitContext;

  constructor(
    private readonly git: GitService,
    private readonly tabs: CommitTabs,
    private readonly repoRoot: string,
    private readonly settings: () => { briefTokenBudget: number; maxDiffTabs: number },
    readonly hooks: ControllerHooks = {},
  ) {}

  async openCommit(node: CommitNode): Promise<void> {
    const { linked, group } = node;
    const sha = linked.commit.sha;
    if (this.currentSha && this.currentSha !== sha) await this.close(this.currentSha);

    const files = await this.git.changedFiles(sha);
    const brief = group
      ? buildBrief({
          session: group.session,
          eventIndex: linked.eventIndex,
          commitTime: linked.commit.authorDate,
          laterCommits: group.commits
            .filter((c) => Date.parse(c.commit.authorDate) > Date.parse(linked.commit.authorDate))
            .map((c) => ({ shortSha: c.commit.shortSha, subject: c.commit.subject })),
          budgetTokens: this.settings().briefTokenBudget,
        })
      : null;
    const ctx: CommitContext = { linked, group, brief, files, repoRoot: this.repoRoot };
    this.currentSha = sha;
    this.current = ctx;
    await this.hooks.onOpen?.(ctx);
    await this.tabs.open(sha, linked.commit.shortSha, files, this.settings().maxDiffTabs);
  }

  async close(sha: string): Promise<void> {
    await this.hooks.onClose?.(sha);
    await this.tabs.closeFor(sha);
    if (this.currentSha === sha) {
      this.currentSha = undefined;
      this.current = undefined;
    }
  }

  async openRef(path: string, line?: number): Promise<void> {
    const uri = vscode.Uri.file(`${this.repoRoot}/${path}`);
    try {
      const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
      await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One, preview: true });
    } catch {
      vscode.window.showWarningMessage(`${path} no longer exists in the working tree.`);
    }
  }
}
```

- [ ] **Step 7: Wire it into activation** — edit `src/vscode/extension.ts`:

  - Add imports:

```ts
import { CommitTabs, DIFF_SCHEME, GitContentProvider } from './commitTabs';
import { Controller } from './controller';
import type { CommitNode } from '../core/treeModel';
```

  - After `const qa = …`, add:

```ts
  const tabs = new CommitTabs(repoRoot);
  const controller = new Controller(git, tabs, repoRoot, () => config());
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new GitContentProvider()));
```

  - Replace the placeholder `explainDiff.openCommit` registration with:

```ts
    vscode.commands.registerCommand('explainDiff.openCommit', (node: CommitNode) => controller.openCommit(node)),
```

  - Change the `ExplainDiffApi.controller` type to `Controller`, and return `controller` instead of `undefined`.

- [ ] **Step 8: Build and typecheck**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: everything passes.

- [ ] **Step 9: Manual check**

Press F5. Click a commit and check the following:
- One diff tab opens per changed file, titled like `handler.ts · M · a1c9e42`, each showing `sha^` vs `sha`.
- Added files have an empty left side.
- Clicking another commit closes the previous commit's diff tabs.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: open per-file diff tabs for the selected commit"
```

---

### Task 14: Explanation panel (first tab)

**Files:**
- Create: `src/vscode/explainPanel.ts`, `src/webview/diagrams.ts`, `media/webview.css`
- Modify (replace placeholder): `src/webview/explainMain.ts`
- Modify: `src/vscode/extension.ts` (hook the panel into the controller)

**Interfaces:**
- Consumes: `renderExplainView`, `ExplainView`, `HeaderInfo` (Task 11); `ExplainToHost`, `HostToWebview` (Task 11); `ExplainService`, `ExplanationInvalidError` (Task 8); `ClaudeNotFoundError`, `ClaudeAbortedError`, `ClaudeRunError` (Task 7); `toMarkdown` (Task 10); `CommitContext`, `CommitTabs` (Task 13); `DIAGRAM_KEYS`, `DiagramKey`, `getDiagram` (Task 6).
- Produces:
  - `src/webview/diagrams.ts`: `renderDiagrams(container: HTMLElement, onError: (key: string, code: string, error: string) => void): Promise<void>`
  - `src/vscode/explainPanel.ts`: `class ExplainPanel { readonly sha: string; constructor(ctx: CommitContext, deps: ExplainPanelDeps); load(force?: boolean): Promise<void>; reveal(): void; dispose(): void; onDidDispose: vscode.Event<void> }` where `interface ExplainPanelDeps { extensionUri: vscode.Uri; explain: ExplainService; store: ExplanationStore; tabs: CommitTabs; maxDiffTabs: () => number; openRef: (path: string, line?: number) => void; onCached: (sha: string) => void; openChat: (prefill?: string) => void }`
  - `webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: 'explain.js' | 'chat.js', body: string): string`, exported from `explainPanel.ts` for reuse in Task 15.

- [ ] **Step 1: Shared diagram renderer** — `src/webview/diagrams.ts`

```ts
import mermaid from 'mermaid';

let seq = 0;

export async function renderDiagrams(container: HTMLElement, onError: (key: string, code: string, error: string) => void): Promise<void> {
  const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
  for (const fig of Array.from(container.querySelectorAll<HTMLElement>('figure.diagram:not(.failed)'))) {
    const src = fig.querySelector<HTMLElement>('pre.mermaid-src');
    const out = fig.querySelector<HTMLElement>('.mermaid-out');
    if (!src || !out) continue;
    const code = src.textContent ?? '';
    try {
      await mermaid.parse(code);
      const { svg } = await mermaid.render(`ed-mermaid-${++seq}`, code);
      out.innerHTML = svg;
      src.hidden = true;
    } catch (e) {
      document.getElementById(`ded-mermaid-${seq}`)?.remove();
      src.hidden = false;
      onError(fig.dataset.key ?? '', code, e instanceof Error ? e.message : String(e));
    }
  }
}
```

- [ ] **Step 2: Explanation webview script** — `src/webview/explainMain.ts`

```ts
import type { ExplainToHost, HostToWebview } from '../shared/messages';
import { renderDiagrams } from './diagrams';

declare function acquireVsCodeApi(): { postMessage(m: ExplainToHost): void };
const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;

root.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  ev.preventDefault();
  const d = el.dataset;
  vscode.postMessage({
    type: d.action,
    path: d.path,
    line: d.line ? Number(d.line) : undefined,
    key: d.key,
    section: d.section,
  } as ExplainToHost);
});

window.addEventListener('message', async (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  if (m.type !== 'render') return;
  const y = window.scrollY;
  root.innerHTML = m.html;
  window.scrollTo(0, y);
  await renderDiagrams(root, (key, code, error) => vscode.postMessage({ type: 'diagramError', key, code, error }));
});

vscode.postMessage({ type: 'ready' });
```

- [ ] **Step 3: Styles** — `media/webview.css`

```css
:root { --accent: #e08a6c; }
body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 14px; line-height: 1.65; }
#root { max-width: 860px; margin: 0 auto; padding: 28px 28px 64px; display: flex; flex-direction: column; gap: 32px; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; } a:hover { text-decoration: underline; }
code, pre { font-family: var(--vscode-editor-font-family); font-size: 12.5px; }
pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; }
button, a.button { font: inherit; font-size: 13px; min-height: 30px; padding: 0 12px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); display: inline-flex; align-items: center; }
button.primary, a.button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.muted { color: var(--vscode-descriptionForeground); }
.add { color: var(--vscode-gitDecoration-addedResourceForeground); } .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
.hdr { display: flex; flex-direction: column; gap: 12px; }
.hdr .meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.hdr h1 { margin: 0; font-size: 24px; line-height: 1.25; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; } .cached { margin-left: auto; font-size: 12px; color: var(--vscode-descriptionForeground); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; } .chips a { font-size: 12px; padding: 3px 10px; border-radius: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.sec { display: flex; flex-direction: column; gap: 12px; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.sec-head h2 { margin: 0; font-size: 12.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
.sec-head .ask { min-height: 26px; border-radius: 13px; font-size: 11.5px; background: transparent; border-color: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.lead { font-size: 16.5px; margin: 0; }
.card { background: var(--vscode-editorWidget-background); border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.card h3, .sec h3 { margin: 0; font-size: 14.5px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.ba { background: var(--vscode-editor-background); border-radius: 6px; padding: 8px 10px; }
.tag { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.tag.chosen { color: var(--vscode-gitDecoration-addedResourceForeground); background: transparent; padding: 0; }
.tag.rejected { color: var(--vscode-gitDecoration-deletedResourceForeground); background: transparent; padding: 0; }
.tag.migration, .tag.inferred, .tag.risk { background: #e8b25a; color: #1f1f1f; }
.chips-row { display: flex; flex-wrap: wrap; gap: 6px; } .chip { font-size: 12px; padding: 3px 8px; border-radius: 4px; background: var(--vscode-editor-background); }
.quote { margin: 0; background: var(--vscode-editorWidget-background); border-radius: 8px; padding: 14px 18px; }
.quote blockquote { margin: 0; font-size: 15px; } .quote figcaption { font-size: 12px; color: var(--vscode-descriptionForeground); }
figure.diagram { margin: 0; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px; overflow-x: auto; }
figure.diagram figcaption { font-size: 11.5px; color: var(--vscode-descriptionForeground); padding-top: 6px; }
figure.diagram .err { color: var(--vscode-errorForeground); font-size: 12px; }
ul { margin: 0; padding-left: 20px; } .watch { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.glossary { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px 24px; } .glossary dt { font-weight: 600; } .glossary dd { margin: 0; }
.state { display: flex; flex-direction: column; gap: 14px; align-items: flex-start; } .state-title { margin: 0; font-size: 18px; }
.steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; } .step .mark { display: inline-block; width: 22px; } .step.todo { color: var(--vscode-descriptionForeground); } .step.active .mark { color: var(--accent); }
.log { font-family: var(--vscode-editor-font-family); font-size: 11.5px; color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px; align-self: stretch; }
footer { border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; font-size: 12px; }
/* chat */
body.chat { height: 100vh; display: flex; flex-direction: column; } body.chat #root { display: none; }
.chat-hdr { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.chat-hdr .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; } .chat-hdr .label { font-size: 11px; font-weight: 600; letter-spacing: .06em; color: var(--vscode-descriptionForeground); } .chat-hdr .title { font-weight: 600; }
#thread { flex: 1 1 auto; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; font-size: 13.5px; }
.day { display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--vscode-descriptionForeground); } .day::before, .day::after { content: ''; flex: 1; height: 1px; background: var(--vscode-panel-border); }
.msg { border-radius: 10px; padding: 9px 13px; max-width: 92%; } .msg p { margin: 0 0 6px; } .msg p:last-child { margin: 0; }
.msg.me { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); } .msg.me .about { font-size: 11px; opacity: .85; }
.msg.claude { background: var(--vscode-editorWidget-background); } .msg .files { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
.suggestions { display: flex; flex-wrap: wrap; gap: 6px; } .suggest { min-height: 26px; border-radius: 13px; font-size: 11.5px; }
.notice { font-size: 12px; color: var(--vscode-descriptionForeground); } .error { font-size: 12px; color: var(--vscode-errorForeground); } .center { text-align: center; margin-top: 40px; }
.composer { border-top: 1px solid var(--vscode-panel-border); padding: 10px 16px 12px; display: flex; gap: 8px; align-items: flex-end; }
.composer textarea { flex: 1; min-width: 0; resize: none; font: inherit; font-size: 13px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 8px 10px; }
.composer button { min-height: 40px; }
.visually-hidden { position: absolute; left: -9999px; }
```

- [ ] **Step 4: Explanation panel** — `src/vscode/explainPanel.ts`

```ts
import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { ClaudeAbortedError, ClaudeNotFoundError, ClaudeRunError, ClaudeTimeoutError } from '../core/claudeRunner';
import { DIAGRAM_KEYS, getDiagram, type DiagramKey } from '../core/explanationSchema';
import type { ExplanationStore } from '../core/explanationStore';
import { ExplanationInvalidError, type ExplainService } from '../core/explainService';
import { toMarkdown } from '../core/markdownExport';
import type { StoredExplanation } from '../core/types';
import type { ExplainToHost, HostToWebview } from '../shared/messages';
import { renderExplainView, type ExplainView, type HeaderInfo } from '../webview/render';
import type { CommitTabs } from './commitTabs';
import type { CommitContext } from './controller';

export interface ExplainPanelDeps {
  extensionUri: vscode.Uri;
  explain: ExplainService;
  store: ExplanationStore;
  tabs: CommitTabs;
  maxDiffTabs: () => number;
  openRef: (path: string, line?: number) => void;
  onCached: (sha: string) => void;
  openChat: (prefill?: string) => void;
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: 'explain.js' | 'chat.js', body: string): string {
  const nonce = randomBytes(16).toString('hex');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', script));
  const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${css}"></head><body${script === 'chat.js' ? ' class="chat"' : ''}>${body}<script nonce="${nonce}" src="${js}"></script></body></html>`;
}

export class ExplainPanel {
  static readonly viewType = 'explainDiff.explanation';
  readonly sha: string;
  private readonly panel: vscode.WebviewPanel;
  private view: ExplainView;
  private abort?: AbortController;
  private disposed = false;
  private attempted = new Set<string>();
  private failed: Record<string, string> = {};
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(private readonly ctx: CommitContext, private readonly deps: ExplainPanelDeps) {
    this.sha = ctx.linked.commit.sha;
    this.panel = vscode.window.createWebviewPanel(
      ExplainPanel.viewType,
      `Explain · ${ctx.linked.commit.shortSha}`,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'dist'), vscode.Uri.joinPath(deps.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = webviewHtml(this.panel.webview, deps.extensionUri, 'explain.js', '<div id="root"></div>');
    this.view = { kind: 'loading', header: this.header(), steps: [], log: [] };
    this.panel.webview.onDidReceiveMessage((m: ExplainToHost) => void this.onMessage(m));
    this.panel.onDidDispose(() => {
      // Spec §10: a run keeps going after the tab closes; the result is still cached and the tree dot fills in.
      this.disposed = true;
      this.disposeEmitter.fire();
    });
  }

  private header(stored?: StoredExplanation): HeaderInfo {
    const c = this.ctx.linked.commit;
    const files = this.ctx.files;
    return {
      shortSha: c.shortSha,
      subject: c.subject,
      branch: this.ctx.group?.session.branch,
      date: c.authorDate,
      added: files.reduce((n, f) => n + (f.added ?? 0), 0),
      removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
      fileCount: files.length,
      sessionTitle: this.ctx.group?.session.title,
      generatedAt: stored?.generatedAt,
      hasTranscript: !!this.ctx.group,
    };
  }

  private render() {
    if (this.disposed) return;
    const msg: HostToWebview = { type: 'render', html: renderExplainView(this.view) };
    void this.panel.webview.postMessage(msg);
  }

  private showReady(stored: StoredExplanation) {
    this.view = { kind: 'ready', header: this.header(stored), stored, files: this.ctx.files, maxDiffTabs: this.deps.maxDiffTabs(), failedDiagrams: this.failed };
    this.render();
  }

  reveal() {
    this.panel.reveal(vscode.ViewColumn.One, false);
  }

  dispose() {
    this.panel.dispose();
  }

  async load(force = false): Promise<void> {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.attempted.clear();
    this.failed = {};
    const cached = force ? undefined : await this.deps.store.get(this.sha);
    if (cached) return this.showReady(cached);

    const steps: { label: string; state: 'done' | 'active' | 'todo' }[] = [
      { label: this.ctx.group ? 'Read the session' : 'No session found, using the commit only', state: 'done' },
      { label: 'Claude is exploring the code', state: 'active' },
      { label: 'Writing the explanation', state: 'todo' },
    ];
    const log: string[] = [];
    this.view = { kind: 'loading', header: this.header(), steps, log };
    this.render();
    try {
      const stored = await this.deps.explain.explain(
        { sha: this.sha, brief: this.ctx.brief },
        {
          force,
          signal: abort.signal,
          onProgress: (p) => {
            if (p.type === 'tool') log.push(`${p.name.padEnd(5)} ${p.detail}`);
            else {
              steps[1].state = 'done';
              steps[2].state = 'active';
            }
            this.render();
          },
        },
      );
      this.deps.onCached(this.sha);
      this.showReady(stored);
    } catch (e) {
      if (e instanceof ClaudeAbortedError) return;
      const header = this.header();
      if (e instanceof ClaudeNotFoundError) this.view = { kind: 'error', header, variant: 'cliMissing', message: e.message };
      else if (e instanceof ClaudeTimeoutError) this.view = { kind: 'error', header, variant: 'failed', message: `${e.message}.` };
      else if (e instanceof ClaudeRunError) this.view = { kind: 'error', header, variant: 'failed', message: e.message, details: `exit code ${e.exitCode}\n${e.stderrTail}` };
      else if (e instanceof ExplanationInvalidError) this.view = { kind: 'error', header, variant: 'failed', message: e.message, details: e.raw.slice(0, 4000) };
      else this.view = { kind: 'error', header, variant: 'failed', message: e instanceof Error ? e.message : String(e) };
      this.render();
    }
  }

  private async onMessage(m: ExplainToHost) {
    const c = this.ctx.linked.commit;
    switch (m.type) {
      case 'ready':
        return this.render();
      case 'openRef':
        return this.deps.openRef(m.path, m.line);
      case 'focusFile': {
        const file = this.ctx.files.find((f) => f.path === m.path);
        if (file && !file.binary) await this.deps.tabs.focusFile(this.sha, c.shortSha, file);
        return;
      }
      case 'openAllChanges':
        return this.deps.tabs.openAll(this.sha, c.shortSha, this.ctx.files);
      case 'openChat':
        return this.deps.openChat();
      case 'askSection':
        return this.deps.openChat(`About "${m.section}": `);
      case 'regenerate':
        return this.load(true);
      case 'retry':
        return this.load(false);
      case 'cancel':
        this.abort?.abort();
        this.view = { kind: 'error', header: this.header(), variant: 'failed', message: 'Cancelled.' };
        return this.render();
      case 'openSettings':
        return void vscode.commands.executeCommand('workbench.action.openSettings', 'explainDiff.claudePath');
      case 'openTranscript':
        if (this.ctx.group) await vscode.window.showTextDocument(vscode.Uri.file(this.ctx.group.session.filePath), { viewColumn: vscode.ViewColumn.One, preview: true });
        return;
      case 'export':
        return this.exportMarkdown();
      case 'diagramError':
        return this.onDiagramError(m.key, m.code, m.error);
      case 'retryDiagram':
        delete this.failed[m.key];
        this.attempted.delete(m.key);
        return this.repair(m.key as DiagramKey, (await this.currentDiagram(m.key as DiagramKey)) ?? '', 'Retry requested');
    }
  }

  private async currentDiagram(key: DiagramKey) {
    const s = await this.deps.store.get(this.sha);
    return s ? getDiagram(s.explanation, key) : undefined;
  }

  private async onDiagramError(key: string, code: string, error: string) {
    if (!DIAGRAM_KEYS.includes(key as DiagramKey)) return; // chat-style diagrams are not repairable here
    if (this.attempted.has(key)) {
      this.failed[key] = error;
      const s = await this.deps.store.get(this.sha);
      if (s) this.showReady(s);
      return;
    }
    await this.repair(key as DiagramKey, code, error);
  }

  private async repair(key: DiagramKey, code: string, error: string) {
    this.attempted.add(key);
    try {
      await this.deps.explain.repairDiagram(this.sha, key, code, error);
    } catch (e) {
      this.failed[key] = e instanceof Error ? e.message : String(e);
    }
    const s = await this.deps.store.get(this.sha);
    if (s) this.showReady(s);
  }

  private async exportMarkdown() {
    const s = await this.deps.store.get(this.sha);
    if (!s) return;
    const c = this.ctx.linked.commit;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${this.ctx.repoRoot}/${c.shortSha}-explanation.md`),
      filters: { Markdown: ['md'] },
    });
    if (!target) return;
    await writeFile(target.fsPath, toMarkdown(s, { shortSha: c.shortSha, subject: c.subject, branch: this.ctx.group?.session.branch, date: c.authorDate, sessionTitle: this.ctx.group?.session.title }), 'utf8');
    vscode.window.showInformationMessage(`Saved ${target.fsPath}`);
  }
}
```

- [ ] **Step 5: Hook the panel into the controller** — edit `src/vscode/extension.ts`:

  - Add the import `import { ExplainPanel } from './explainPanel';`.
  - Replace `const controller = new Controller(git, tabs, repoRoot, () => config());` with:

```ts
  let explainPanel: ExplainPanel | undefined;
  let openChat: (prefill?: string) => void = () => {};
  const controller = new Controller(git, tabs, repoRoot, () => config(), {
    onOpen: async (ctx) => {
      explainPanel = new ExplainPanel(ctx, {
        extensionUri: context.extensionUri, explain, store, tabs,
        maxDiffTabs: () => config().maxDiffTabs,
        openRef: (p, l) => void controller.openRef(p, l),
        onCached: (sha) => tree.markCached(sha),
        openChat: (prefill) => openChat(prefill),
      });
      const panel = explainPanel;
      panel.onDidDispose(() => {
        if (explainPanel === panel) explainPanel = undefined;
      });
      void panel.load();
    },
    onClose: () => {
      explainPanel?.dispose();
      explainPanel = undefined;
    },
  });
```

  - In `Controller.openCommit` (`src/vscode/controller.ts`), after `await this.tabs.open(...)`, the explanation tab must regain focus. Add an `afterTabs` hook:

```ts
export interface ControllerHooks {
  onOpen?: (ctx: CommitContext) => void | Promise<void>;
  afterTabs?: (ctx: CommitContext) => void | Promise<void>;
  onClose?: (sha: string) => void | Promise<void>;
}
```

  At the end of `openCommit`:

```ts
    await this.hooks.afterTabs?.(ctx);
```

  In `extension.ts`, add to the hooks object: `afterTabs: () => explainPanel?.reveal(),`.

  - Remove the line `void explain;`.

- [ ] **Step 6: Build and typecheck**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: everything passes.

- [ ] **Step 7: Manual check**

Press F5 and click a commit. Check the following:
- **Tab order:** the tab set reads `Explain · <sha>` first (focused), then the diff tabs.
- **States:** the panel shows state A with live "Grep … / Read …" lines, then the eight sections with rendered diagrams.
- **Links and chips:** clicking a file chip focuses its diff tab, and a `path:line` link opens the file at that line.
- **Header buttons:** Export Markdown saves a file; Regenerate re-runs; Cancel stops a run.
- **CLI errors:** setting `explainDiff.claudePath` to a bogus value shows state B.
- **Broken diagram:** editing a cached JSON diagram in globalStorage to `flowchart LR\n A(-->B` and reopening shows one repair attempt. If that fails, state E appears.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: explanation panel as the first tab of the commit tab set"
```

---

### Task 15: Chat panel beside the explanation

**Files:**
- Create: `src/vscode/chatPanel.ts`
- Modify (replace placeholder): `src/webview/chatMain.ts`
- Modify: `src/vscode/extension.ts`

**Interfaces:**
- Consumes: `QAService` (Task 9); `renderChatHeader`, `renderChatThread`, `ChatView`, `PendingTurn` (Task 11); `ChatToHost`, `HostToWebview` (Task 11); `webviewHtml` (Task 14); `CommitContext` (Task 13); `renderDiagrams` (Task 14); `ClaudeAbortedError` (Task 7); `parseSectionPrefix` (Task 9).
- Produces: `class ChatPanel { constructor(deps: { extensionUri: vscode.Uri; qa: QAService; store: ExplanationStore; openRef: (path: string, line?: number) => void }); show(ctx: CommitContext | undefined, o?: { prefill?: string; focus?: boolean }): void; refresh(): Promise<void>; readonly isOpen: boolean }`

- [ ] **Step 1: Chat webview script** — `src/webview/chatMain.ts`

```ts
import type { ChatToHost, HostToWebview } from '../shared/messages';
import { renderDiagrams } from './diagrams';

declare function acquireVsCodeApi(): { postMessage(m: ChatToHost): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();
const header = document.getElementById('header')!;
const thread = document.getElementById('thread')!;
const input = document.getElementById('q') as HTMLTextAreaElement;
const send = document.getElementById('send') as HTMLButtonElement;
let busy = false;

const submit = () => {
  if (busy) {
    vscode.postMessage({ type: 'stop' });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: 'send', text });
  input.value = '';
};

send.addEventListener('click', submit);
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    submit();
  }
});

document.body.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  ev.preventDefault();
  const d = el.dataset;
  if (d.action === 'suggest') vscode.postMessage({ type: 'suggest', text: d.text ?? '' });
  else if (d.action === 'newConversation') vscode.postMessage({ type: 'newConversation' });
  else if (d.action === 'openRef') vscode.postMessage({ type: 'openRef', path: d.path ?? '', line: d.line ? Number(d.line) : undefined });
});

window.addEventListener('message', async (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  if (m.type === 'header') header.innerHTML = m.html;
  else if (m.type === 'thread') {
    const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
    thread.innerHTML = m.html;
    await renderDiagrams(thread, () => {});
    if (atBottom) thread.scrollTop = thread.scrollHeight;
  } else if (m.type === 'busy') {
    busy = m.busy;
    send.textContent = busy ? 'Stop' : 'Send';
  } else if (m.type === 'prefill') {
    input.value = m.text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
});

vscode.postMessage({ type: 'ready' });
```

- [ ] **Step 2: Chat panel** — `src/vscode/chatPanel.ts`

```ts
import * as vscode from 'vscode';
import { ClaudeAbortedError } from '../core/claudeRunner';
import type { ExplanationStore } from '../core/explanationStore';
import { parseSectionPrefix, type QAService } from '../core/qaService';
import type { ChatToHost, HostToWebview } from '../shared/messages';
import { renderChatHeader, renderChatThread, type ChatView, type PendingTurn } from '../webview/render';
import type { CommitContext } from './controller';
import { webviewHtml } from './explainPanel';

const BODY = `<div id="header"></div><div id="thread" aria-live="polite"></div>
<div class="composer"><label for="q" class="visually-hidden">Message</label><textarea id="q" rows="2" placeholder="Ask about this commit…"></textarea><button id="send" class="primary">Send</button></div>`;

export class ChatPanel {
  static readonly viewType = 'explainDiff.chat';
  private panel?: vscode.WebviewPanel;
  private ctx?: CommitContext;
  private pending?: PendingTurn;
  private abort?: AbortController;
  private notice?: string;
  private error?: string;
  private pendingPrefill?: string;

  constructor(private readonly deps: { extensionUri: vscode.Uri; qa: QAService; store: ExplanationStore; openRef: (path: string, line?: number) => void }) {}

  get isOpen() {
    return !!this.panel;
  }

  show(ctx: CommitContext | undefined, o: { prefill?: string; focus?: boolean } = {}) {
    if (ctx?.linked.commit.sha !== this.ctx?.linked.commit.sha) {
      this.abort?.abort();
      this.pending = undefined;
      this.notice = undefined;
      this.error = undefined;
    }
    this.ctx = ctx;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        ChatPanel.viewType,
        'Chat',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !o.focus },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'dist'), vscode.Uri.joinPath(this.deps.extensionUri, 'media')] },
      );
      this.panel.webview.html = webviewHtml(this.panel.webview, this.deps.extensionUri, 'chat.js', BODY);
      this.panel.webview.onDidReceiveMessage((m: ChatToHost) => void this.onMessage(m));
      this.panel.onDidDispose(() => {
        this.abort?.abort();
        this.panel = undefined;
      });
    } else if (o.focus) {
      this.panel.reveal(undefined, false);
    }
    this.panel.title = ctx ? `Chat · ${ctx.linked.commit.shortSha}` : 'Chat';
    if (o.prefill) {
      this.pendingPrefill = o.prefill;
      this.post({ type: 'prefill', text: o.prefill });
    }
    void this.refresh();
  }

  private post(m: HostToWebview) {
    void this.panel?.webview.postMessage(m);
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    const c = this.ctx?.linked.commit;
    const stored = c ? await this.deps.store.get(c.sha) : undefined;
    const view: ChatView = {
      commit: c ? { shortSha: c.shortSha, subject: c.subject } : undefined,
      unavailable: !c ? 'Select a commit to start chatting.' : !stored ? 'The explanation is still being written. You can ask once it is ready.' : undefined,
      thread: stored?.thread ?? [],
      pending: this.pending,
      notice: this.notice,
      error: this.error,
    };
    this.post({ type: 'header', html: renderChatHeader(view) });
    this.post({ type: 'thread', html: renderChatThread(view) });
    this.post({ type: 'busy', busy: !!this.pending });
  }

  private async ask(text: string) {
    const ctx = this.ctx;
    if (!ctx || this.pending || !text.trim()) return;
    const sha = ctx.linked.commit.sha;
    const { section, question } = parseSectionPrefix(text);
    this.pending = { question, section, partial: '', files: [] };
    this.notice = undefined;
    this.error = undefined;
    const abort = (this.abort = new AbortController());
    await this.refresh();
    try {
      const r = await this.deps.qa.ask(sha, text, {
        brief: ctx.brief,
        signal: abort.signal,
        onProgress: (p) => {
          if (!this.pending) return;
          if (p.type === 'tool' && p.detail) this.pending.files.push(p.detail);
          if (p.type === 'text') this.pending.partial = p.text;
          void this.refresh();
        },
      });
      if (r.usedFallback) this.notice = 'The earlier chat session had expired, so Claude started a fresh one with this commit’s context.';
    } catch (e) {
      if (!(e instanceof ClaudeAbortedError)) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.ctx?.linked.commit.sha === sha) this.pending = undefined;
      await this.refresh();
    }
  }

  private async onMessage(m: ChatToHost) {
    switch (m.type) {
      case 'ready':
        await this.refresh();
        if (this.pendingPrefill) this.post({ type: 'prefill', text: this.pendingPrefill });
        this.pendingPrefill = undefined;
        return;
      case 'send':
      case 'suggest':
        this.pendingPrefill = undefined;
        return this.ask(m.text);
      case 'stop':
        this.abort?.abort();
        return;
      case 'newConversation': {
        if (!this.ctx) return;
        const ok = await vscode.window.showWarningMessage('Start a new conversation? The current chat history for this commit will be cleared.', { modal: true }, 'Clear');
        if (ok !== 'Clear') return;
        await this.deps.qa.clear(this.ctx.linked.commit.sha);
        this.notice = undefined;
        this.error = undefined;
        return this.refresh();
      }
      case 'openRef':
        return this.deps.openRef(m.path, m.line);
    }
  }
}
```

- [ ] **Step 3: Wire the chat into activation** — edit `src/vscode/extension.ts`:

  - Add `import { ChatPanel } from './chatPanel';`.
  - Before the `controller` declaration, add:

```ts
  const chat = new ChatPanel({ extensionUri: context.extensionUri, qa, store, openRef: (p, l) => void controller.openRef(p, l) });
```

  `controller` is declared with `const` below. Because the closure only runs later, referencing it here is fine at runtime and type-correct.
  - Replace `let openChat: (prefill?: string) => void = () => {};` with:

```ts
  const openChat = (prefill?: string) => chat.show(controller.current, { prefill, focus: true });
```

  - In the `afterTabs` hook, also show the chat beside without stealing focus:

```ts
    afterTabs: (ctx) => {
      explainPanel?.reveal();
      chat.show(ctx, { focus: false });
    },
```

  - In the `onCached` callback, also refresh the chat: `onCached: (sha) => { tree.markCached(sha); void chat.refresh(); },`.
  - Remove the line `void qa;`.
  - Add `chat` to the returned API. Extend `ExplainDiffApi` with `chat: ChatPanel` and return `{ tree, store, refresh, controller, chat }`.

- [ ] **Step 4: Build and typecheck**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: everything passes.

- [ ] **Step 5: Manual check**

Press F5 and click a commit. Check the following:
- **Layout:** the explanation and diff tabs are on the left, and "Chat · <sha>" opens in the right group.
- **Before the explanation is ready:** the chat says the explanation is still being written. Once the explanation finishes, suggestions appear.
- **Asking:** ask a question. Send turns into Stop, "Checking: …" lists files, and the answer renders with links and any mermaid diagram.
- **Ask buttons:** clicking a section's Ask button prefills `About "Ripple map": `.
- **History:** close VS Code, reopen, and click the same commit. The history is still there, grouped by day.
- **Switching commits:** clicking another commit closes the old tab set, and the chat switches to the new commit's history.
- **New conversation:** it asks for confirmation, then clears the thread.
- **Export:** Export Markdown includes the conversation.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: chat panel beside the explanation with per-commit history"
```

---

### Task 16: Smoke test, packaging and README

**Files:**
- Create: `.vscode-test.mjs`, `test/smoke/makeFixture.mjs`, `test/smoke/extension.test.cjs`, `README.md`

**Interfaces:**
- Consumes: `ExplainDiffApi` (`tree`, `store`, `refresh`, `controller`, `chat`) from Tasks 12–15; `test/fixtures/explanation.json`; env var `EXPLAIN_DIFF_PROJECTS_DIR` (Task 12).

- [ ] **Step 1: Fixture builder** — `test/smoke/makeFixture.mjs`

```js
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve('.vscode-test');
const repo = join(root, 'fixture-repo');
const projects = join(root, 'projects');
rmSync(repo, { recursive: true, force: true });
rmSync(projects, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });

const g = (...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'greet.js'), 'module.exports = () => "hi";\n');
writeFileSync(join(repo, 'README.md'), '# Fixture\n');
g('add', '.');
g('commit', '-q', '-m', 'Add greeting\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
const short = g('rev-parse', '--short', 'HEAD');

const slug = repo.replace(/[^a-zA-Z0-9]/g, '-');
mkdirSync(join(projects, slug), { recursive: true });
const base = { sessionId: 'smoke', cwd: repo, gitBranch: 'main' };
const lines = [
  { type: 'ai-title', aiTitle: 'Fixture session', sessionId: 'smoke' },
  { ...base, type: 'user', timestamp: '2026-10-08T10:00:00.000Z', message: { role: 'user', content: 'Add a greeting module' } },
  { ...base, type: 'assistant', timestamp: '2026-10-08T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git commit -m "Add greeting"' } }] } },
  { ...base, type: 'user', timestamp: '2026-10-08T10:01:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: `[main (root-commit) ${short}] Add greeting` }] } },
];
writeFileSync(join(projects, slug, 'smoke.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`fixture repo ${repo}, transcripts ${projects}`);
```

- [ ] **Step 2: Test runner config** — `.vscode-test.mjs`

```js
import { defineConfig } from '@vscode/test-cli';
import { resolve } from 'node:path';

export default defineConfig({
  files: 'test/smoke/**/*.test.cjs',
  workspaceFolder: resolve('.vscode-test/fixture-repo'),
  env: { EXPLAIN_DIFF_PROJECTS_DIR: resolve('.vscode-test/projects') },
  mocha: { ui: 'tdd', timeout: 60000 },
});
```

- [ ] **Step 3: Smoke test** — `test/smoke/extension.test.cjs`

```js
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vscode = require('vscode');

suite('Explain Diff smoke', () => {
  test('lists the fixture session and opens the commit tab set with a cached explanation and chat', async () => {
    const ext = vscode.extensions.getExtension('local.explain-diff');
    assert.ok(ext, 'extension present');
    const api = await ext.activate();
    await api.refresh();

    const roots = api.tree.getChildren();
    const session = roots.find((n) => n.kind === 'session');
    assert.ok(session, 'session node present');
    assert.strictEqual(session.label, 'Fixture session');
    const commit = session.children[0];
    assert.match(commit.label, /Add greeting/);

    const explanation = JSON.parse(readFileSync(join(__dirname, '../fixtures/explanation.json'), 'utf8'));
    await api.store.put({ sha: commit.sha, promptVersion: 1, generatedAt: new Date().toISOString(), claudeSessionId: 'x', inferred: false, explanation, thread: [] });

    await vscode.commands.executeCommand('explainDiff.openCommit', commit);
    assert.strictEqual(api.controller.currentSha, commit.sha);

    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(tabs.some((t) => t.label === `Explain · ${commit.linked.commit.shortSha}`), 'explanation tab open');
    assert.ok(tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.label.startsWith('greet.js · A')), 'diff tab for greet.js open');
    assert.ok(api.chat.isOpen, 'chat panel open');
  });
});
```

- [ ] **Step 4: Run the smoke test**

Run: `npm run test:smoke`
Expected: VS Code downloads (first run only) and launches. Mocha reports `1 passing`.

- [ ] **Step 5: Package**

Run: `npm run package`
Expected: `explain-diff-0.1.0.vsix` is created. Install it in VS Code with `code --install-extension explain-diff-0.1.0.vsix`. In Cursor, use the Extensions view → "…" → Install from VSIX.

- [ ] **Step 6: README** — `README.md`

```markdown
# Explain Diff

See the commits Claude Code made in this repo, grouped by the session that made them, and get a plain-language, diagram-rich explanation of any commit — why it was made (from the session conversation), what changed, how it works now, what else uses it, what to expect and what to watch out for. Chat about the commit in a panel beside the explanation; the conversation is kept per commit.

## Requirements
- VS Code 1.90+ or Cursor
- Claude Code CLI installed and signed in (`claude --version` works in a terminal)
- A git repository where you have used Claude Code

## Use
1. Open the **Claude Commits** view in the activity bar.
2. Click a commit. The explanation opens as the first tab, followed by one diff tab per changed file; the chat opens beside it.
3. Use **Ask** on any section heading to ask about it in the chat. **Export Markdown** saves the explanation and conversation.

## Settings
| Setting | Default | Meaning |
|---|---|---|
| `explainDiff.claudePath` | `claude` | Path to the Claude Code CLI |
| `explainDiff.timeoutSeconds` | `180` | Time limit for one explanation or answer |
| `explainDiff.model` | (CLI default) | Model passed to `claude --model` |
| `explainDiff.briefTokenBudget` | `30000` | Size of the session context sent to Claude |
| `explainDiff.maxDiffTabs` | `20` | Maximum per-file diff tabs per commit |

## Privacy
Session transcripts are read locally from `~/.claude/projects`. Explanations run through your own Claude Code CLI with read-only tools; nothing is written to your repository.

## Development
`npm install`, `npm run build`, `npm test` (unit), `npm run test:smoke` (VS Code), F5 to debug, `npm run package` for a `.vsix`.
```

- [ ] **Step 7: Run the full verification and commit**

Run: `npm run typecheck && npx vitest run && npm run test:smoke`
Expected: all green.

```bash
git add -A
git commit -m "test: VS Code smoke test, packaging and README"
```
