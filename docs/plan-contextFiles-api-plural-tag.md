# Plan: Use contextFiles API + plural tag name

## Problems

### 1. XML parsing fragility

`loadRefsFromPrompt()` parses `<project_instructions>` blocks from the system prompt string via regex:

```typescript
const instrRe =
  /<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g;
```

`event.systemPromptOptions.contextFiles` provides the same data as `Array<{ path: string; content: string }>` — the canonical source. Using the structured API is more reliable (no regex edge cases, no XML parsing assumptions) with zero tradeoffs.

Pi's `loadContextFileFromDir()` populates `contextFiles` from `~/.pi/agent/` + ancestor-walked from cwd, looking for `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Each entry has the resolved absolute `path` and the file's `content`.

### 2. Wrong tag plurality

Pi uses plural: `project_instructions`. Our injection tag `project_reference` should also be plural: `project_references`.

## Fix

### 1. Switch to `contextFiles` API

**Remove**: `loadRefsFromPrompt()`, the regex, the `systemPrompt.slice()` to extract `<project_context>`.

**Add back**: `loadRefsFromContextFiles()` — same as the original but now without the hardcoded filename filter (processes ALL entries, matching the intent of the XML approach).

```typescript
function loadRefsFromContextFiles(
  contextFiles: Array<{ path: string; content: string }>,
): RefContent[] {
  // ... same logic as loadRefsFromPrompt, iterating over structured data
}
```

**Handler change**:

```typescript
// Before:
cachedRefs = loadRefsFromPrompt(event.systemPrompt);

// After:
cachedRefs = loadRefsFromContextFiles(
  event.systemPromptOptions.contextFiles ?? [],
);
```

### 2. Rename tag to `project_references`

```typescript
// Before:
`<project_reference path="${r.resolvedPath}">\n${r.content}\n</project_reference>`

// After:
`<project_references path="${r.resolvedPath}">\n${r.content}\n</project_references>`
```

## Files Changed

| File | Change |
|------|--------|
| `extensions/index.ts` | Replace `loadRefsFromPrompt()` with `loadRefsFromContextFiles()`, rename tag |
| `extensions/index.test.ts` | Replace `loadRefsFromPrompt` tests with `loadRefsFromContextFiles`, update tag assertions |

## TDD Workflow

### Cycle 1: Rename tag `project_reference` → `project_references`

**RED** — update test assertion to expect plural tag (no code change yet):
- Replace `buildPrompt()` usage in test with literal string containing `<project_references>` (since we'll change `buildPrompt` in cycle 2 anyway, hardcode the expected tag in this cycle)
- Run → tests fail (code still writes `<project_reference>`)

**GREEN** — rename tag in `index.ts`:
```typescript
// In before_agent_start handler:
`<project_references path="${r.resolvedPath}">\n${r.content}\n</project_references>`
```
- Run → tests pass

### Cycle 2: Switch from `loadRefsFromPrompt` to `loadRefsFromContextFiles`

**RED** — replace `loadRefsFromPrompt` test suite with `loadRefsFromContextFiles`:
- Rewrite tests to accept `Array<{ path: string; content: string }>` instead of mock prompt string
- Remove `buildPrompt()` helper, use `{ path, content }` objects directly
- Same test behaviors (empty/no-refs/single/multiple/directory/CLAUDE/dedup/absolute/tilde/quoted)
- Import `loadRefsFromContextFiles` instead of `loadRefsFromPrompt`
- Run → tests fail (function doesn't exist yet)

**GREEN** — implement in `index.ts`:
- Replace `loadRefsFromPrompt()` with `loadRefsFromContextFiles()`
- Remove regex, `systemPrompt.slice()`, `instrRe`
- Iterate over `contextFiles` array directly
- Update handler to call `loadRefsFromContextFiles(event.systemPromptOptions.contextFiles ?? [])`
- Run → all tests pass

### Integration test

Same flow: implement → `pi install .` → `/reload` → send prompt → `/export` → verify.

```bash
sed -n '1161p' pi-session-*.html | \
  sed 's/.*id="session-data"[^>]*>//' | \
  sed 's/<\/script.*//' | \
  base64 -d | \
  python3 -c "
import sys, json, re
data = json.load(sys.stdin)
sp = data['systemPrompt']

ctx_start = sp.index('<project_context>')
ctx_end = sp.index('</project_context>') + len('</project_context>')
ctx_block = sp[ctx_start:ctx_end]

instr_count = ctx_block.count('<project_instructions path=')
ref_count = ctx_block.count('<project_references path=')
assert instr_count >= 2, f'Expected >= 2 instructions, got {instr_count}'
assert ref_count >= 2, f'Expected >= 2 references, got {ref_count}'

paths = re.findall(r'<project_references path=\"([^\"]+)\">', ctx_block)
assert any('README.md' in p for p in paths), 'README.md not injected'
assert any('karpathy-guidelines' in p for p in paths), 'karpathy not injected'

print(f'OK: {instr_count} instructions + {ref_count} references')
for p in paths:
    print(f'  ref: {p}')
print('PASS')
"
```
