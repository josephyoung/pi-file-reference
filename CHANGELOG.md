# Changelog

## 0.1.7

### Added
- **Extension filter**: `parseRefs` drops non-`.md`/`.mdc` file refs at parse time.
- **Directory filter**: only `.md`/`.mdc` files at depth 1; dot-files (`.*`) skipped.
- **Size limit**: files over 100KB are skipped (per-file, not total).

### Changed
- **Refactored**: `loadRefsFromContextFiles` split into `getAllFilePathFromContextFiles` → `parseFileAndContent` → `inject` pipeline.
- **RefContent**: simplified from `{ref, resolvedPath, content}` to `{path, content}`.

## 0.1.6

### Changed
- **Source**: @refs are now parsed from Pi's `systemPromptOptions.contextFiles` (structured API) instead of reading AGENTS.md from disk with hardcoded paths. Supports all context files Pi discovers (AGENTS.md, CLAUDE.md, CLAUDE.MD, custom).
- **Injection tag**: Renamed from `<project_instructions>` to `<project_references>` for clarity — Pi uses `project_instructions` for its own context files; the extension injects a different category.
- **Injection target**: References are injected inside Pi's existing `<project_context>` section instead of a separate `# Context References` block.
- **Filter**: `parseRefs` now requires `.` or `/` in refs to avoid false positives on documentation words (`@filepath`, `@refs`).

### Fixed
- **Multi-AGENTS.md support**: Previously broke on first AGENTS.md found (project), skipping user-level `~/.pi/agent/AGENTS.md`. Now processes all context files.

### Verified
- Pi rebuilds the system prompt from `_baseSystemPrompt` each `before_agent_start`. Injections must run on every call — a one-shot flag would lose references after the first prompt.
