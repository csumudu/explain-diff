# Contributing to Explain Diff

Thanks for helping! The most valuable contribution right now is **support for another coding-agent harness** (Codex CLI, Gemini CLI, Cursor agent, Aider, OpenCode, …). This guide gets you from clone to pull request.

## Development setup

Requirements: Node 20+, Git, VS Code or Cursor. The repo pins pnpm through `packageManager`.

```bash
corepack enable          # once; or prefix commands with `corepack`
pnpm install
pnpm build               # bundles into dist/
pnpm test                # unit + harness contract tests (vitest)
pnpm typecheck
pnpm test:smoke          # launches VS Code and drives the extension
```

Press **F5** in VS Code to run the extension in a development window.

## Project tour

| Path | What lives there |
|---|---|
| `src/core/` | Harness-neutral logic: git, commit linking, session brief, prompts, explanation schema, cache, chat |
| `src/harnesses/` | **Adapters.** `types.ts` (the contract), `registry.ts`, and one folder per harness |
| `src/webview/` | HTML rendering (pure, unit-tested) and the browser scripts for the explanation and chat panels |
| `src/vscode/` | VS Code glue: sidebar, diff tabs, panels, activation |
| `test/harnesses/contract/` | The shared test suite every session source must pass |

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow.

## Adding a new harness

A harness needs a **session source**, and may add an **explainer**.

| Role | Interface | Needed? |
|---|---|---|
| Session source: finds and parses the agent's session logs | `SessionSource` in `src/harnesses/types.ts` | Yes |
| Explainer: lets that agent write explanations and chat answers | `Explainer` in `src/harnesses/types.ts` | Optional (Claude Code can explain sessions from any source) |

### 1. Learn the harness's session format

Find where it stores sessions (e.g. a folder per project under the user's home directory), the file format, and how it records:

- user prompts and assistant replies,
- tool calls and their results, especially **shell commands** (to find `git commit`) and **file edits**,
- timestamps, working directory and git branch, if any.

Write these notes in `src/harnesses/<id>/README.md`. Look at `src/harnesses/claude-code/README.md` for the shape.

### 2. Implement the session source

Create `src/harnesses/<id>/source.ts`:

```ts
import type { SessionSource, SourceOptions } from '../types';

export function createMyAgentSource(o: SourceOptions): SessionSource {
  return {
    id: 'my-agent',                // kebab-case, never changes once released
    displayName: 'My Agent',
    async findSessionFiles(workspacePaths, platform) { /* return absolute paths, [] if none */ },
    async parseSession(file) { /* return a Session; skip malformed lines, never throw on them */ },
    commitTrailer: /^Co-Authored-By:\s*My Agent\b/im, // if the agent signs its commits
  };
}
```

Rules for `parseSession`:

- Set `sourceId` to your `id`.
- Emit events in time order: `user`, `assistant`, `toolCall`, `toolResult` (see `SessionEvent` in `src/core/types.ts`).
- On every tool call that ran a shell command, set **`shellCommand`** to the command line. This is how commits are linked to sessions.
- On every tool call that edited a file, set **`editedFile`**.
- Pair `toolResult.toolUseId` with the call's `id`.
- Strip system or meta noise from user text. Skip subagent or sidechain traffic.
- Use `o.homeDir` and `o.env` instead of reading `os.homedir()` or `process.env` directly, so tests can point at fixtures. Support an env var override for your sessions folder.
- Match workspace folders case-insensitively on Windows.

### 3. Register it

Add one line to `SESSION_SOURCES` in `src/harnesses/registry.ts`, and add your id to the `enum` of `explainDiff.sessionSources` in `package.json`.

### 4. Add fixtures and run the contract suite

Create `test/fixtures/harnesses/<id>/` laid out exactly like the harness stores sessions, plus `expectations.json` (see the Claude Code one). Use **made-up content**, never a real session, because real sessions contain private code and prompts. Include at least one shell `git commit` with its output, one file edit, and one malformed line. Set `malformedFile` in `expectations.json` to the session file that holds the malformed line; the contract checks that it still parses.

Then create `test/harnesses/<id>/source.test.ts`:

```ts
import { join } from 'node:path';
import { createMyAgentSource } from '../../../src/harnesses/my-agent/source';
import { describeSessionSource } from '../contract/sessionSource.contract';

describeSessionSource('my-agent',
  (dir) => createMyAgentSource({ homeDir: '/unused', env: { MY_AGENT_SESSIONS_DIR: join(dir, 'sessions') } }),
  join(__dirname, '../../fixtures/harnesses/my-agent'));
```

`pnpm test` must pass. Add unit tests for anything format-specific that the contract does not cover.

### 5. (Optional) Add an explainer

Implement `Explainer` in `src/harnesses/<id>/explainer.ts`, register it in `EXPLAINERS`, and add it to the `explainDiff.explainer` enum. Requirements:

- **Read-only.** The model may read and search the repository, and run read-only git commands. It must not edit files or run arbitrary commands. Explain how you enforce this in the PR.
- Send prompts on stdin or through an API, never as one huge command-line argument (Windows limits command lines to about 8 KB).
- Validate every value that reaches a command line (see `buildArgs` and `buildSpawn` in `src/harnesses/claude-code/explainer.ts`).
- Report progress through `onProgress` (tool name and target) so the panel can show what the agent is reading.
- Support `resumeSessionId` for chat follow-ups, or ignore it. The chat falls back to a fresh run carrying the history.
- Declare every setting you read in `package.json`. Settings that pick an executable, a path or extra CLI arguments must be `"scope": "machine"`, so a cloned repository's `.vscode/settings.json` cannot change them.
- Throw the errors from `src/harnesses/errors.ts`.
- Add tests with a fake CLI or a mocked API, like `test/fake-claude/fake-claude.mjs`.

### 6. Document it

Add a row to the **Supported harnesses** table in `README.md`.

## Pull request checklist

- [ ] `pnpm typecheck`, `pnpm test` and `pnpm build` pass. Run `pnpm test:smoke` too if you touched `src/vscode/` or `src/webview/`.
- [ ] New behaviour has tests that failed before your change.
- [ ] Fixtures contain no real code, prompts, paths or names.
- [ ] No new runtime dependencies without discussion in an issue first.
- [ ] User-facing text is plain language.
- [ ] One harness or feature per PR.

## Reporting bugs and proposing harnesses

Use the issue templates. For a new harness, the **New harness** template asks for the session format details above. Opening one before you start avoids duplicate work.

By contributing you agree that your contributions are licensed under the MIT License, and you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
