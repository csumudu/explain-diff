# Harness adapters and open-source publishing: design

Date: 2026-10-09
Status: draft, awaiting review
Builds on: `2026-10-09-explain-diff-design.md`

## 1. Goal

Make Explain Diff ready for outside contributors to add support for other coding-agent harnesses
(Codex CLI, Gemini CLI, Cursor agent, Aider, …), then publish it as the public GitHub repo
`csumudu/explain-diff` (MIT, a single fresh initial commit).

Success: a contributor can add a new harness by creating one folder under `src/harnesses/`,
registering it in one file, adding fixtures, and passing the shared contract tests, without
editing core logic.

Out of scope: writing a second real adapter; Marketplace/Open VSX publishing.

## 2. Two extension points

Claude Code is currently wired into the core. It is split into two independent roles, each
defined by an interface in `src/harnesses/types.ts`:

```ts
/** Where agent sessions come from. One per harness. */
export interface SessionSource {
  id: string;                    // stable, kebab-case: 'claude-code'
  displayName: string;           // 'Claude Code'
  /** Absolute paths (or other opaque refs) of session logs recorded for any of these folders. */
  findSessionFiles(workspacePaths: string[], platform?: NodeJS.Platform): Promise<string[]>;
  /** Parse one session log into the generic Session model (see §3). Must not throw on bad lines. */
  parseSession(file: string): Promise<Session>;
  /** Trailer this harness adds to commits it makes, if any. Used to find agent commits. */
  commitTrailer?: RegExp;
}

/** Who writes explanations and chat answers. */
export interface Explainer {
  id: string;                    // 'claude-code'
  displayName: string;           // 'Claude Code'
  run(o: RunOptions): Promise<RunResult>;      // unchanged RunOptions/RunResult
  version(): Promise<string | null>;
  /** Shown when the tool is missing (state B). */
  setup: { message: string; docsUrl: string; settingId: string };
}
```

`RunOptions`, `RunResult` and `RunProgress` move unchanged to `src/harnesses/types.ts`. The error
classes become harness-neutral in `src/harnesses/errors.ts`: `ExplainerNotFoundError`,
`ExplainerTimeoutError`, `ExplainerAbortedError`, `ExplainerRunError` (same fields as today).
Explainers must stay read-only: the contract in CONTRIBUTING and SECURITY says an explainer may
read the repository but must never let the model write files or run arbitrary commands.

`src/harnesses/registry.ts` lists the built-ins:

```ts
export const SESSION_SOURCES: Record<string, (opts: SourceOptions) => SessionSource>;
export const EXPLAINERS: Record<string, (opts: ExplainerOptions) => Explainer>;
```

`SourceOptions` gives `{ homeDir: string; env: NodeJS.ProcessEnv }`. `ExplainerOptions` gives
`{ settings: (key: string) => unknown }` so each explainer reads its own settings (Claude Code reads
`explainDiff.claudePath`).

## 3. Harness-neutral session model

`Session` and `SessionEvent` stay as they are, with two optional, normalised fields on tool calls
that sources fill in, so core code no longer knows harness tool names:

```ts
| { kind: 'toolCall'; time; id; name; input; shellCommand?: string; editedFile?: string }
```

- `shellCommand`: the command line a shell-type tool ran (Claude Code: `Bash` → `input.command`).
- `editedFile`: the file an edit-type tool changed (Claude Code: `Edit`/`Write`/`MultiEdit`/`NotebookEdit` → `input.file_path`).
- `Session` gains `sourceId: string` (the `SessionSource.id`).

Core changes: `commitLinker` uses `shellCommand` instead of `name === 'Bash'`; `briefBuilder` uses
`editedFile` instead of its tool-name list; `CommitInfo.claudeCoAuthored` becomes
`agentCoAuthored`; `GitService.listClaudeCommits()` becomes `listAgentCommits(trailers: RegExp[])`.
`StoredExplanation.claudeSessionId` becomes `explainerSessionId` (`ExplanationStore.get` maps the old
field name so existing caches keep working).

## 4. Layout

```
src/harnesses/
  types.ts, errors.ts, registry.ts
  claude-code/
    source.ts        (was core/sessionLocator.ts + core/transcriptParser.ts)
    explainer.ts     (was core/claudeRunner.ts)
    README.md        (format notes for this harness)
test/harnesses/
  contract/sessionSource.contract.ts   (reusable suite)
  claude-code/source.test.ts           (runs the contract with Claude Code fixtures)
  claude-code/explainer.test.ts        (was test/unit/claudeRunner.test.ts)
test/fixtures/harnesses/claude-code/   (fixture project dir + expectations.json)
```

## 5. Contract tests

`describeSessionSource(name, makeSource, fixture)` runs the same checks for every source. A fixture
is a directory laid out the way the harness stores sessions, plus `expectations.json`:

```json
{
  "workspacePath": "C:\\work\\app",
  "sessions": [{ "title": "…", "branch": "…", "minEvents": 5, "shellCommandContains": "git commit",
                 "editedFile": "src/a.ts", "commitShortSha": "a1c9e42" }]
}
```

Checks: the source finds exactly the expected session files for the workspace (and none for an
unrelated folder); each parses with the expected title/branch; events are in time order; at least one
`toolCall` has `shellCommand` containing the expected text and one has the expected `editedFile`; the
linker finds `commitShortSha` from the parsed session; a file with a malformed line still parses.

## 6. Extension behaviour

- New settings: `explainDiff.sessionSources` (array of source ids, default `["claude-code"]`, enum of
  registered ids) and `explainDiff.explainer` (default `"claude-code"`). Both `scope: "machine"`.
- All enabled sources are read; sessions from every source are listed together, newest first. A
  session's description is prefixed with its source's display name, e.g. `Claude Code · main · Oct 9, 14:02 · 3 commits`.
- Agent commits = commits matching any enabled source's `commitTrailer`. The group "Other Claude
  commits" becomes "Other agent commits".
- UI copy that names Claude uses the explainer's `displayName` (e.g. "Claude Code is exploring the
  code"); state B uses `explainer.setup`. The view message shows `<explainer> <version> · N sessions scanned`.
- `EXPLAIN_DIFF_PROJECTS_DIR` stays as the Claude Code source's test override.

## 7. Publishing

- New files: `LICENSE` (MIT, © 2026 Sumudu Jayasinghe), `README.md` (rewritten: what/why, screenshot,
  install from VSIX, usage, settings, supported harnesses table, privacy, roadmap), `CONTRIBUTING.md`
  (dev setup with pnpm, project tour, test commands, PR checklist, "Adding a new harness" step-by-step
  using Claude Code as the worked example), `ARCHITECTURE.md` (component diagram and data flow in
  Mermaid), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` (read-only explainer rule,
  how to report), `.github/ISSUE_TEMPLATE/{bug_report.yml,new_harness.yml}`,
  `.github/pull_request_template.md`, `.github/workflows/ci.yml` (pnpm install, typecheck, unit tests
  on ubuntu/windows/macos; build + package on ubuntu).
- `package.json`: `repository`, `bugs`, `homepage` fields; `publisher` stays `local`.
- `docs/media/` holds the README screenshot (captured from the VS Code smoke fixture, not a real project).
- Published as one fresh commit "Initial public release" on `main` of a new public repo
  `csumudu/explain-diff`; the local history stays on `master`/`feat/explain-diff` untouched.

## 8. Testing

All existing tests keep passing after the move (adjusted imports). New: the contract suite run against
Claude Code fixtures; registry test (ids unique, defaults registered); store legacy-field test;
`listAgentCommits` with two trailers; tree description includes the source name. Smoke test still passes.
