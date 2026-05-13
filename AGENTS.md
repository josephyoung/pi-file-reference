# pi-file-reference

Pi extension that resolves `@filepath` references in AGENTS.md and injects file content into system prompt.

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
4. Injects them into the system prompt under `# Context References`

## Conventions

- All code and comments in English
- AGENTS.md drives the project-level AI context
- Match Pi's internal style for context file injection (`## @path\n\n{content}`)

## Publishing

After functional changes are committed and pushed, update the GitHub repo description if the feature set changed:

```bash
gh repo edit --description "Pi extension: ..."
```

Then bump version and push the tag:

```bash
npm version patch   # bump version (patch/minor/major)
git push origin main --tags   # tag push triggers CI publish
```

- GitHub Actions workflow: `.github/workflows/publish.yml`
- Uses npm Trusted Publishing (OIDC) — no tokens or OTP needed
- Runs `npm publish --access public --provenance` on tag push
