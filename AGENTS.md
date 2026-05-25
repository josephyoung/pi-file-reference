# pi-file-reference

Pi extension: resolve @filepath (files & directories) in AGENTS.md, inject into system prompt

## Structure

- `extensions/index.ts` — extension entry point
  - `session_start`: scan AGENTS.md for @refs, read files, cache in memory
  - `before_agent_start`: inject cached file content into system prompt
- `package.json` — pi package metadata

## How it works

When a user writes `@./docs/style-guide.md` in their AGENTS.md:

1. The extension finds all `@` references in AGENTS.md (cwd or ~/.pi/agent/)
2. Resolves paths (relative, absolute, ~/ expansion)
3. If the path is a file: reads it
   If the path is a directory: reads all immediate files (depth 1, sorted alphabetically)
4. Injects them into the system prompt as `<project_instructions>` blocks inside Pi's `<project_context>` section

## Conventions

- All code and comments in English
- AGENTS.md drives the project-level AI context
- Inject referenced files as `<project_instructions>` blocks inside Pi's `<project_context>` section

## Publishing

After functional changes are committed and pushed, update the GitHub repo description if the feature set changed:

```bash
gh repo edit --description "Pi extension: ..."
```

Then bump version and push:

```bash
npm version patch   # bump version, creates commit + tag
git push origin main --tags   # push to main + tag; CI triggers on package.json change
```

- GitHub Actions workflow: `.github/workflows/publish.yml`
- Trigger: push to main when `package.json` changes, or `workflow_dispatch`
- Uses Node 24 (npm 11) for OIDC support — Node 22's npm 10 OIDC is broken
- Uses npm Trusted Publishing (OIDC) — no tokens or OTP needed
- Runs on `refs/heads/main` — npm Trusted Publisher must accept branch `main`

@README.md
