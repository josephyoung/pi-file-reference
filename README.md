# pi-file-reference

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that resolves `@filepath` references in `AGENTS.md` and injects the referenced file contents into the system prompt.

## How it works

1. On `session_start`, the extension resets its cache for the new session
2. On the first `before_agent_start`, parses `@filepath` references from Pi's loaded context files (AGENTS.md, CLAUDE.md, custom context files), filters to `.md`/`.mdc` only, ignores dot-files and files over 100KB
3. Reads the referenced files and caches their contents (survives reload)
4. On every `before_agent_start`, injects the file contents into the system prompt as `<project_references>` blocks inside Pi's `<project_context>` section

## @filepath syntax

```
@path/to/file.md
@./path/to/file.md
@~/path/to/file.md
@"path with spaces.md"
@/absolute/path/to/file.md
```

The `@` must be at the start of a line or preceded by whitespace.

**Only `.md` and `.mdc` file references are resolved.** References to other file types (e.g., `@notes.txt`) are silently ignored.

### Directory references

When `@path` resolves to a directory, **only `.md` and `.mdc` files** at depth 1 are injected. Dot-files (e.g., `.hidden.md`) are skipped. Files larger than 100KB are also skipped.

```
@./docs
```

Injects `@docs/style-guide.md`, `@docs/patterns.md`, etc. (sorted alphabetically). Subdirectories are skipped. Trailing `/` is stripped (`@./docs/` works the same).

## Installation

```bash
# Install from npm (once published)
pi install npm:@josephyoung/pi-file-reference

# Or clone and link locally
git clone https://github.com/your-org/pi-file-reference.git
cd pi-file-reference
npm install
pi install .
```

## Usage

In your `AGENTS.md`:

```markdown
# Project guidelines
Always follow the patterns in @./docs/style-guide.md

# Architecture
@~/.project-arch/backend-overview.md
```

The referenced files' content is automatically injected into the system prompt at the start of each agent turn.

## Caching & LLM Prompt Cache

File contents are read once per session (first `before_agent_start`) and reused for every subsequent turn. This guarantees the injected system prompt bytes are identical within a session, making the extension LLM prompt-cache friendly.

| Decision | Rationale |
|----------|-----------|
| Cache at session level | New session = fresh content. No stale data across sessions. |
| Cache file contents, not full prompt | `lastIndexOf` + string concat is O(n) and memcpy-cheap. Caching the full prompt + hashing the raw prompt for hit/miss adds complexity with no observable gain. |
| Inject before `</project_context>` | References are project context material. Fallback to appending if the tag is absent. |

The only cache-invalidation risk is other extensions producing non-deterministic system prompt output, which is rare and outside our control.

See [docs/lifecycle-diagram.md](docs/lifecycle-diagram.md) for a visual flow and [docs/system-prompt-injection.md](docs/system-prompt-injection.md) for full design analysis.

## License

MIT

See [CHANGELOG.md](CHANGELOG.md) for version history.
