# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/csumudu/explain-diff/security/advisories/new), not in public issues. You'll get a reply within 7 days.

## What counts

Explain Diff runs a coding agent over your repository and shows its output in a webview. Treat these as security issues:

- Any way for an explainer run to **write files, run arbitrary commands, or escalate its permissions**. For example, injecting CLI flags through settings, session ids or file names.
- Model or repository text that **executes as HTML/JS** in the explanation or chat webviews.
- Workspace settings or repository content that make the extension run a different binary than the user configured.
- Leaking session transcripts or explanations outside the user's machine (other than to the configured agent).

## Known limitations

- The Claude Code explainer restricts tools with prefix rules (`Bash(git log:*)` and similar). Some git flags (for example `--output`) can write files, so a prompt-injected model could in principle misuse an allowed command. Tightening this is welcome; reports are in scope.
- `claude -p` also applies your own Claude Code permission settings. If you have allowed extra tools globally, explanations can use them too.

## Design rules contributors must keep

- Explainers are read-only (see CONTRIBUTING, "Add an explainer").
- Every value that reaches a command line is validated. On Windows, unsafe characters are rejected rather than escaped.
- Settings that choose executables are `machine`-scoped, so a cloned repository cannot change them.
- All model output is escaped before rendering, and webviews use a nonce CSP.
