# Explain Diff — VS Code / Cursor extension: design

Date: 2026-10-09
Status: draft, awaiting review
UI design canvas: https://claude.ai/artifact/VnU2968pKwtSawqCv9agAM (boards "Main", "States", "DiffTab")

## 1. Goal

Claude Code sessions make commits faster than people can absorb them. This extension lists the
commits Claude made, grouped by the session that made them, and for any selected commit produces a
plain-language "360°" explanation: what changed, why (from the session conversation), how it works
now, what else in the app depends on it, what to expect, and what to watch out for — with diagrams.
The reader can then chat about the commit in a panel beside the explanation; the conversation is kept per commit.

**Readers:** primarily the developer who ran the session; explanations must also be good enough to
share with reviewers and to use for onboarding.

**Success:** clicking a commit gives, within about a minute, an explanation the developer trusts
without reading the transcript or the full diff; every claim about code links to a `file:line`.

**Constraints**
- Local repositories only; strictly read-only towards git (never commits, checkouts or rewrites).
- Uses the user's installed Claude Code CLI (`claude`) — no API key handling.
- Only the standard VS Code extension API, so it runs unchanged in VS Code and Cursor.

**Out of scope (v1):** remote/hosted repos, explaining non-Claude commits on purpose, team-shared
cache, editing or reverting commits from the UI, languages other than English.

## 2. Data sources

- **Session transcripts:** `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the
  workspace path with every non-alphanumeric character replaced by `-`
  (e.g. `C:\Users\me\proj` → `C--Users-me-proj`). Worktrees under `<repo>/.claude/worktrees/*` have
  their own slugs and are included. Each line is a JSON object; relevant fields: `type`
  (`user`, `assistant`, `ai-title`, …), `timestamp`, `cwd`, `gitBranch`, `sessionId`, `message`
  (content blocks: `text`, `tool_use` with `input.command`, `tool_result`). Unknown line types are ignored.
- **Git:** the `git` CLI in the workspace repo.

## 3. Architecture

```
SessionLocator → TranscriptParser → CommitLinker ← GitService
                                         │
                                CommitsTreeProvider (sidebar)
                                         │ select
ExplanationStore ⇄ ExplainService → BriefBuilder + GitService
        ⇅                │
    QAService ──→ ClaudeRunner (spawns `claude -p`, cwd = repo)
                         │
               ExplanationPanel (webview, bundled mermaid)
```

| Unit | Responsibility | Depends on |
|---|---|---|
| SessionLocator | Workspace folder (+ its worktrees) → transcript directory → list of `*.jsonl` | fs |
| TranscriptParser | Stream a JSONL file into a `Session`: id, title (`ai-title`), branch, cwd, start/end time, ordered events (user prompt, assistant text, tool call, tool result), edited file paths | none (pure) |
| CommitLinker | Link commits to sessions (rules in §4) | parser output, GitService |
| GitService | `log`, `show --stat`, `show <sha>` diff, `cat-file -e`, trailer lookup | git |
| BriefBuilder | Token-budgeted session brief for one commit (§5) | none (pure) |
| ClaudeRunner | Spawn `claude` with given args; stream/parse output; cancellation; timeout | `claude` on PATH or configured path |
| ExplainService | Cache check → brief → run → validate → diagram repair → store | the above |
| QAService | Follow-up questions on a commit; clearing a conversation (§7) | ClaudeRunner, ExplanationStore |
| ChatPanel | Single chat webview beside the explanation, follows the active explanation (§7) | VS Code API, QAService |
| ExplanationStore | JSON files in `context.globalStorageUri/explanations/<repoId>/<sha>.json` | fs |
| CommitsTreeProvider | Sidebar "Claude Commits" view | VS Code API |
| ExplanationPanel | Webview rendering explanation, diagrams and actions | VS Code API, mermaid |
| CommitTabs | Opens/closes a commit's tab set: explanation + per-file diff tabs; `explain-diff:` content provider (§8a) | VS Code API, GitService |

TranscriptParser, CommitLinker (with GitService injected) and BriefBuilder contain no `vscode`
imports so they can be unit-tested directly.

## 4. Linking commits to sessions

1. **Direct match:** in each session, find `tool_use` Bash calls whose command contains `git commit`;
   in the paired `tool_result`, match `^\[(?<branch>[^\]\s]+)(?: \([^)]*\))? (?<sha>[0-9a-f]{7,40})\]`.
   Resolve the short SHA with `git rev-parse` and keep it only if it exists in the repo.
2. **Fallback:** commits whose message has a `Co-Authored-By: Claude` trailer, not matched in step 1,
   are assigned to the session on the same branch whose time window (first to last event, +10 min)
   contains the commit's author date. If several sessions qualify, choose the one with the closest last event.
3. **Leftover** Claude-trailer commits go to the "Other Claude commits" group.

A commit that was later rewritten (rebased/amended) and no longer exists is dropped silently.
The tree is rebuilt on activation, on the Refresh button, and when `.git/HEAD` or `.git/refs` change
(debounced 2 s). Parsed sessions are cached in memory by file path + mtime.

## 5. Session brief

Built by BriefBuilder for one commit, target budget ~30k tokens (estimated as chars/4):

1. Session header: title, branch, start time.
2. All user prompts (excluding meta/command caveat lines), in order.
3. Assistant `text` blocks (no thinking, no tool payloads), in order.
4. A full-fidelity window around the commit: the events from the user prompt preceding the commit
   through the commit's tool result, including tool calls (inputs truncated to 500 chars) and results
   (truncated to 1,000 chars).
5. Files edited in the session before the commit.

When over budget, trim in this order: assistant text outside the window (keep first and last
sentences of each), then older user prompts (keep first 300 chars each). The commit window is never trimmed.
Later commits in the same session are summarised in one line each so Claude knows what came next.

## 6. Generating an explanation

ClaudeRunner invokes:

```
claude -p --output-format stream-json --verbose \
  --allowedTools "Read,Grep,Glob,Bash(git show:*),Bash(git log:*),Bash(git grep:*)" \
  --disallowedTools "Edit,Write,NotebookEdit" \
  --max-turns 40
```

The prompt is written to the process's stdin (prompts can be ~100k characters, beyond Windows'
command-line limit). On Windows the command runs through the shell so `claude.cmd` installs work.
Streaming events feed the live "files Claude is reading" list in state A.

with `cwd` = repo root. The prompt contains: the writing rules, the JSON schema, the session brief,
`git show --stat <sha>`, and the diff (if the diff exceeds ~40k chars, include the stat plus the
largest hunks and tell Claude to read the rest itself). The CLI result's `result` text must be a
JSON object; its `session_id` is stored for Q&A.

**Writing rules in the prompt:** plain language and short sentences; define every technical term in
the glossary; every claim about code cites `path:line`; ripple-map entries must come from searches
actually run — anything unverified goes in `possiblyRelated`; never invent intent — when there is no
session, say the reasoning is inferred.

**Explanation schema** (validated with zod; `promptVersion` is part of the cache key):

```ts
type Explanation = {
  summary: string;                         // 1. In one breath (2–3 sentences)
  why: {                                   // 2. Why we did this
    inferred: boolean;                     // true when no session is linked
    userQuotes: { text: string; time?: string }[];
    narrative: string;
    decisions: { choice: string; kind: "chosen" | "rejected"; reason: string }[];
    timelineMermaid?: string;
  };
  changes: {                               // 3. What changed, grouped by purpose
    title: string; before: string; after: string;
    files: { path: string; line?: number; added: number; removed: number }[];
  }[];
  howItWorks: { narrative: string; diagramMermaid: string };   // 4
  ripple: {                                // 5. Who uses this
    diagramMermaid: string;
    verified: { path: string; line: number; role: string; impact: string }[];
    possiblyRelated: { path: string; reason: string }[];
  };
  expectations: { effects: string[]; howToVerify: string[] };  // 6
  watchOuts: { kind: "migration" | "risk" | "not-done" | "edge-case" | "follow-up"; text: string }[]; // 7
  glossary: { term: string; meaning: string }[];               // 8
};
```

**Validation and repair:** if the output is not valid JSON or fails the schema, retry once, sending
the validation error back to the same session (`--resume`). The webview runs `mermaid.parse()` on
every diagram; an invalid one triggers one repair call containing only that diagram and its
error; still invalid → the panel shows the source in a code block with the error and a "Retry diagram" button.

Timeout: 180 s per run (setting `explainDiff.timeoutSeconds`). Only fully valid results are cached.

## 7. Chat panel (follow-up questions, split view)

- A single **Chat** webview opens in the editor group beside the explanation (`ViewColumn.Beside`)
  when an explanation is first opened, and can be reopened from a "Chat" button in the explanation
  header. Explanation left, chat right.
- The chat **follows the active explanation tab**: its header shows "Chatting about <sha> <subject>";
  switching to another explanation tab swaps in that commit's conversation.
- **History is preserved per commit**: every turn (question, answer, time, files checked) is stored in
  the explanation's cache file, so it survives closing panels and restarting the editor. The thread is
  grouped by day. "New conversation" clears the thread and drops the stored Claude session id, so the next
  question starts a fresh run from the brief and the explanation. Export Markdown includes the thread.
- Each explanation section heading has an **Ask** button that focuses the chat and prefills
  `About "<section title>": `; the section title is stored with the turn and shown above the question.
- Empty thread → suggested questions ("What breaks if I revert this?", "Explain like I'm new here",
  "How would I test this?"); with history, two suggestions stay above the composer.
- QAService runs `claude -p --resume <claudeSessionId> --output-format stream-json --verbose` with the
  same read-only tools and the question, plus a short reminder of the writing rules. This resumes the
  extension's own explanation session, never the user's original coding session. The latest
  `session_id` returned is stored after every answer.
- Answer text appears as each assistant message arrives; Markdown, Mermaid blocks and `path:line`
  references render as in the explanation. Each answer lists the files Claude read or searched.
- If resume fails, QAService starts a fresh run with the brief, the explanation JSON and the thread so
  far, stores the new `session_id`, and shows a one-line notice in the chat.
- One question at a time per commit; Send turns into Stop while an answer is running.

## 8. User interface

See the canvas. Summary:

- **Activity bar view "Claude Commits":** tree of sessions (title, branch, start time, commit count),
  newest first, then "Other Claude commits". Commit rows: short SHA, subject, dot filled when an
  explanation is cached. A Filter button in the view title opens an input box (matches commit
  message, SHA, session title, files edited in the session). The view's message line shows CLI
  status and the number of sessions scanned.
- **Selecting a commit opens a tab set** in the left editor group (see §8a): first the explanation
  tab "Explain · <shortSha>" (focused), then one diff tab per changed file. Cached explanation → shows
  immediately; not cached → starts generation and shows progress (state A) while the diff tabs are
  already usable. The Chat panel sits in the group beside it (§7).
- **Panel header:** SHA, branch, date, +/- stats, link to session; buttons Open all changes (VS Code multi-file
  diff of `sha^..sha`), Chat, Regenerate, Export Markdown, Open session transcript; "Cached · generated <time>".
- **Sections 1–8** as in the schema, each heading with an Ask button (§7). All `path:line` references open the file at that line.
- **Chat panel** beside the explanation (§7).
- **Theme:** uses VS Code theme CSS variables so it follows the user's theme; Mermaid theme
  follows light/dark. Accent for Claude-related highlights.

### 8a. Commit tab set

> **Update 2026-10-10:** diff tabs no longer open automatically. Selecting a commit opens only the explanation
> (and the chat) and expands the commit in the sidebar, which lists its changed files (name, folder, status;
> binary files marked). Clicking a file opens its diff as a **preview** tab, so the next file replaces it unless
> pinned. `explainDiff.maxDiffTabs` and the overflow "Open all N changes" link were removed; the header's
> Open all changes button remains. The diff-editor rules below (refs, titles, content provider, closing the
> previous commit's tabs) still apply.

- Tabs open in this order: explanation, then changed files in `git show --name-status` order.
- Each file tab is VS Code's own diff editor (`vscode.diff`), read-only, comparing the file at `<sha>^`
  (left) with the file at `<sha>` (right). Both sides come from a `explain-diff:` content provider backed
  by `git show <ref>:<path>`. Added files have an empty left side, deleted files an empty right side,
  renamed files use the old path on the left. A root commit has an empty left side.
- Tab title: `<file name> · <status letter> · <shortSha>` (M modified, A added, D deleted, R renamed).
  Diff tabs open with `preview: false` and `preserveFocus: true`, so the explanation keeps focus.
- At most `explainDiff.maxDiffTabs` (default 20) diff tabs open. When a commit changes more files, the
  explanation's "What changed" section shows "Open all N changes", which opens the multi-file diff
  (`vscode.changes`). Binary files (numstat `-`) never get a tab and are marked "binary" in "What changed".
- Selecting a different commit closes the tab set of the previously selected commit (its explanation
  tab and its diff tabs, found through the tab-groups API by their `explain-diff:` URIs / panel id)
  before opening the new set. The Chat panel stays open and switches to the new commit.
- File chips in "What changed" focus that file's diff tab (opening it if it was closed or beyond the
  limit). Other `path:line` links open the working-tree file at that line.

**States (canvas board "States"):** A generating (steps + live list of the files Claude reads, Cancel);
B Claude CLI not found (install link, setting `explainDiff.claudePath`); C no sessions for this
folder; D commit without session (section 2 labelled INFERRED); E diagram could not draw; F generation
failed/timeout (nothing cached, Try again / Open diff).

**Export Markdown:** writes `<sha>-explanation.md` where the user picks (save dialog), with Mermaid
in fenced blocks (renders on GitHub) and the Q&A thread at the end.

## 9. Settings

`explainDiff.claudePath` (default `claude`), `explainDiff.timeoutSeconds` (180),
`explainDiff.model` (empty = CLI default), `explainDiff.briefTokenBudget` (30000),
`explainDiff.maxDiffTabs` (20).

## 10. Error handling

| Situation | Behaviour |
|---|---|
| Workspace is not a git repo | View shows "Open a git repository to see Claude commits." |
| Transcript line malformed | Skip the line, keep parsing |
| `claude` missing or not logged in | State B; tree still works |
| Run times out / non-zero exit | State F; stderr tail under "Technical details" |
| Output invalid after one retry | State F with "View raw output" |
| Diagram invalid after repair | State E for that diagram only |
| Commit no longer in repo | Removed from tree on next refresh |
| User closes panel mid-run | Run continues; result cached; dot fills in the tree |

## 11. Testing

- **Unit (vitest):** TranscriptParser, CommitLinker (fake GitService), BriefBuilder (budget and
  trimming order), schema validation, Markdown export — against small anonymised JSONL fixtures
  derived from real sessions.
- **ClaudeRunner/ExplainService/QAService:** a fake `claude` script returning canned valid, invalid,
  slow and failing outputs (covers retry, timeout, resume fallback).
- **Smoke (@vscode/test-electron):** extension activates, tree populates from a fixture repo +
  fixture transcript directory, selecting a cached commit renders the panel.

## 12. Tech stack

TypeScript, esbuild bundle, VS Code engine `^1.90`, zod, mermaid (bundled into the webview, no CDN),
vitest. Packaged with `vsce` as a `.vsix` (Cursor installs `.vsix` files the same way).
