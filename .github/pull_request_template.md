## What and why

<!-- One harness or feature per PR. Link the issue: Closes #… -->

## How it was tested

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` pass
- [ ] `pnpm test:smoke` (if `src/vscode/` or `src/webview/` changed)
- [ ] New tests failed before the change

## New harness (if applicable)

- [ ] `SessionSource` passes `describeSessionSource` with new fixtures
- [ ] Fixtures are made up: no real code, prompts, paths or names
- [ ] Registered in `src/harnesses/registry.ts` and the `package.json` setting enum
- [ ] `src/harnesses/<id>/README.md` documents the format
- [ ] Explainer (if any) is read-only, and the PR explains how
- [ ] New settings are declared in `package.json`; executable/path/argument settings are `machine`-scoped
- [ ] README "Supported harnesses" table updated
