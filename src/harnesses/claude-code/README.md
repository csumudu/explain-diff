# Claude Code harness

- **Sessions:** `~/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the project path with every non-alphanumeric character replaced by `-` (`C:\work\app` becomes `C--work-app`). Worktrees use `<slug>--claude-worktrees-<name>`. On Windows, drive-letter case varies, so slugs match case-insensitively. Test override: `EXPLAIN_DIFF_PROJECTS_DIR`.
- **Format:** JSON Lines.
  - **Fields used:** `type` (`user`, `assistant`, `ai-title`), `timestamp`, `cwd`, `gitBranch` (`HEAD` when unknown), `sessionId`, and `message.content` blocks (`text`, `tool_use`, `tool_result`).
  - **Skipped:** `isMeta` and `isSidechain` lines, `thinking` blocks, and `<local-command-…>` and `<system-reminder>` text.
- **Normalised fields:**
  - `shellCommand` comes from `Bash` tool calls (`input.command`).
  - `editedFile` comes from `Edit`/`Write`/`MultiEdit`/`NotebookEdit` (`input.file_path`).
- **Commit output:** `git commit` prints `[branch sha] subject` (also `[detached HEAD sha]` and `[main (root-commit) sha]`). `git commit -q` prints nothing, so those commits are matched by timing.
- **Trailer:** `Co-Authored-By: Claude …`.
- **Explainer:** `claude -p --output-format stream-json --verbose`, with the prompt on stdin.
  - **Allowed tools:** `Read,Grep,Glob,Bash(git show:*),Bash(git log:*),Bash(git grep:*)`. Disallowed: `Edit,Write,NotebookEdit`. `--strict-mcp-config` (no MCP servers). Runs `--max-turns 40`.
  - **Chat:** follow-ups use `--resume <session_id>`.
