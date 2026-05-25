# Plan: Match Pi's XML-style context file injection

## Problem

The extension injects referenced file content using markdown headings:

```
# Context References

## @README.md

{content}
```

Pi's own style (from `dist/core/system-prompt.js`) uses XML tags:

```xml
<project_instructions path="/absolute/path/to/file.md">
{content}
</project_instructions>
```

The project AGENTS.md claims "Match Pi's internal style for context file injection" but the extension doesn't — it uses its own `## @path` markdown convention.

## Fix

### 1. Update injection format in `extensions/index.ts`

**Change `RefContent` interface** to store the resolved absolute path:

```typescript
interface RefContent {
  ref: string;          // original reference string (e.g., "README.md")
  resolvedPath: string; // resolved absolute path (e.g., "/Users/joseph/projects/.../README.md")
  content: string;      // file content
}
```

**Update `before_agent_start` injection** — inject into Pi's existing `<project_context>` block instead of appending a separate `# Context References` section:

```typescript
pi.on("before_agent_start", (event, _ctx) => {
  if (!cachedRefs.length) return;

  const blocks = cachedRefs
    .map((r) => `<project_instructions path="${r.resolvedPath}">\n${r.content}\n</project_instructions>`)
    .join("\n\n");

  // Inject inside <project_context> after existing <project_instructions>
  const closeTag = "</project_context>";
  const closeIdx = event.systemPrompt.lastIndexOf(closeTag);

  if (closeIdx !== -1) {
    const prefix = event.systemPrompt.slice(0, closeIdx);
    const suffix = event.systemPrompt.slice(closeIdx);
    return { systemPrompt: prefix + blocks + "\n\n" + suffix };
  }

  // Fallback: no <project_context> (custom prompt), append separately
  return {
    systemPrompt: event.systemPrompt + `\n\n<project_context>\n\n${blocks}\n\n</project_context>`,
  };
});
```

**Result in system prompt:**

```xml
<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/Users/joseph/.pi/agent/AGENTS.md">
{user AGENTS.md}
</project_instructions>

<project_instructions path="/Users/joseph/projects/.../AGENTS.md">
{project AGENTS.md}
</project_instructions>

<project_instructions path="/Users/joseph/projects/.../README.md">
{README content}
</project_instructions>

<project_instructions path="/Users/joseph/.agents/skills/karpathy-guidelines/SKILL.md">
{karpathy content}
</project_instructions>

</project_context>
```

No separate `# Context References` heading needed. All context lives in one `<project_context>` block.

**Update `loadRefs`** to populate `resolvedPath` in each `RefContent`.

### 2. Update AGENTS.md

Remove the misleading convention:

```
- Match Pi's internal style for context file injection (`## @path\n\n{content}`)
```

Replace with:

```
- Inject referenced files as `<project_instructions>` blocks inside Pi's `<project_context>` section
```

### 3. Update README.md

The README's "How it works" section says:

```
4. Injects them into the system prompt under `# Context References`
```

Update to:

```
4. Injects them into the system prompt as `<project_instructions>` blocks inside Pi's `<project_context>` section
```

## TDD: Test Plan

The test verifies that the system prompt in an exported session contains `<project_instructions path="...">` XML tags with the correct resolved paths.

### Test Setup

1. Implement the changes above
2. Run `pi install .` and `/reload`
3. Run `/export` to export the current session
4. Verify the exported session's system prompt

### Test Assertions

In the exported session HTML, decode the base64 session data and verify:

1. **Inside `<project_context>`**: The injected `<project_instructions>` blocks are inside Pi's `<project_context>...</project_context>` block (not in a separate `# Context References` section)
2. **Correct path attributes**: The `path` attribute contains the resolved absolute path
3. **No `# Context References` section**: The extension no longer creates a separate heading
4. **All refs injected**: At least 2 file blocks (README.md + karpathy-guidelines SKILL.md)

### Test Command (after reload + export)

```bash
sed -n '1161p' pi-session-*.html | \
  sed 's/.*id="session-data"[^>]*>//' | \
  sed 's/<\/script.*//' | \
  base64 -d | \
  python3 -c "
import sys, json
data = json.load(sys.stdin)
sp = data['systemPrompt']

# Extract <project_context> block
ctx_start = sp.index('<project_context>')
ctx_end = sp.index('</project_context>') + len('</project_context>')
ctx_block = sp[ctx_start:ctx_end]

# Assert injected refs are inside <project_context>
assert ctx_block.count('<project_instructions path=') >= 4, \
    f'Expected >= 4 <project_instructions> (2 AGENTS + 2 refs), got {ctx_block.count(\"<project_instructions path=\")}'

# Assert no separate # Context References section
assert '# Context References' not in sp[ctx_end:], 'FAIL: separate # Context References section found'

# Count injected file refs (the ones with file paths, not AGENTS.md paths)
print(f'OK: {ctx_block.count(\"<project_instructions path=\")} <project_instructions> blocks inside <project_context>')
print('PASS')
"
```

### Expected Output

```
OK: 4 <project_instructions> blocks inside <project_context>
PASS
```

(2 Pi-injected AGENTS.md blocks + 2 extension-injected file reference blocks)

## Files Changed

| File | Change |
|------|--------|
| `extensions/index.ts` | `RefContent` + `resolvedPath`, injection format, `loadRefs` updates |
| `AGENTS.md` | Fix misleading convention line |
| `README.md` | Update injection description |
