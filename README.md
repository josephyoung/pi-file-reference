# pi-file-reference

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that resolves `@filepath` references in `AGENTS.md` and injects the referenced file contents into the system prompt.

## How it works

1. On `session_start`, the extension resets its cache for the new session
2. On the first `before_agent_start`, parses `@filepath` references from Pi's loaded context files (AGENTS.md, CLAUDE.md, custom context files)
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

### Directory references

When `@path` resolves to a directory, all immediate files (depth 1) are injected:

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

## License

MIT
