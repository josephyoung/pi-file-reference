# Plan: Parse @refs from system prompt XML instead of hardcoded AGENTS.md paths

## Problem

`loadRefs()` hardcodes the paths to AGENTS.md files:

```typescript
const candidates = [
  path.join(cwd, AGENTS_FILE),                          // <cwd>/AGENTS.md
  path.join(os.homedir(), ".pi", "agent", AGENTS_FILE), // ~/.pi/agent/AGENTS.md
];
```

Pi already injects all context files into the system prompt as XML (confirmed in `dist/core/system-prompt.js`):

```xml
<project_context>

Project-specific instructions and guidelines:

<project_instructions path="/path/to/AGENTS.md">
{content}
</project_instructions>

<project_instructions path="/path/to/CLAUDE.md">
{content}
</project_instructions>

</project_context>
```

The extension re-reads the same files from disk — redundant I/O and brittle hardcoding. If Pi ever changes how it discovers context files, the extension won't follow.

## Proposed Design

Parse `@refs` from the `<project_instructions>` blocks already present in `event.systemPrompt`. No API dependency, no hardcoded filenames — the prompt is self-describing.

### Flow

```
session_start
  └─► reset cache + initialized flag

before_agent_start (first call)
  ├─► extract <project_context> from event.systemPrompt
  ├─► parse all <project_instructions path="..."> blocks
  ├─► parse @refs from each block's content
  ├─► resolve refs against each block's directory (from path attribute)
  ├─► read referenced files, cache as RefContent[]
  └─► inject <project_reference path="..."> blocks inside <project_context>

before_agent_start (subsequent calls)
  ├─► use cached RefContent[]
  └─► inject <project_reference> blocks inside <project_context>
```

### Key design decisions

**Tag name: `<project_reference>`** instead of `<project_instructions>`. Pi uses `<project_instructions>` for its own context files. The extension injects a different category (file references resolved from @refs), so a distinct tag avoids confusion and prevents parsing ambiguity (we won't parse our own injected blocks on subsequent turns).

**Parse ALL `<project_instructions>` blocks** — no hardcoded AGENTS.md/CLAUDE.md filter. If Pi injects a context file, it's fair game for @refs. False positives (e.g., `@scoped/package` in a non-ref context) hit `existsSync` → skip + warn — harmless.

**`initialized` caching is safe** — `_baseSystemPrompt` is built once at session start and reused across turns (confirmed in `agent-session.js`). The cache won't go stale.

### Key changes

**Remove**: `loadRefs()` function, `AGENTS_FILE` constant, `ctx.cwd` dependency in `session_start`.

**Add**: `loadRefsFromPrompt(systemPrompt: string)` — extracts `<project_instructions>` blocks from `<project_context>`, parses @refs, resolves files.

**Change**: `session_start` handler — only resets state.

**Change**: `before_agent_start` handler — lazy-initializes cache on first call using `event.systemPrompt`.

**Change**: injection tag from `<project_instructions>` to `<project_reference>`.

### Detailed: `loadRefsFromPrompt`

```typescript
/**
 * Collect @filepath references from <project_instructions> blocks
 * inside Pi's <project_context> section of the system prompt.
 *
 * No hardcoded filenames — processes all <project_instructions> blocks.
 */
function loadRefsFromPrompt(systemPrompt: string): RefContent[] {
  const seen = new Set<string>();
  const results: RefContent[] = [];

  // Extract <project_context> section
  const ctxStart = systemPrompt.indexOf("<project_context>");
  const ctxEnd = systemPrompt.indexOf("</project_context>");
  if (ctxStart === -1 || ctxEnd === -1) return [];

  const contextSection = systemPrompt.slice(ctxStart, ctxEnd);

  // Parse all <project_instructions path="..."> blocks
  const instrRe = /<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g;
  let match: RegExpExecArray | null;

  while ((match = instrRe.exec(contextSection)) !== null) {
    const instrPath = match[1];
    const content = match[2];
    const baseDir = path.dirname(instrPath);

    // Parse @refs from this block's content
    const allRefs: string[] = [];
    for (const line of content.split("\n")) {
      allRefs.push(...parseRefs(line));
    }

    // Deduplicate across all blocks
    const uniqueRefs = allRefs.filter((ref) => {
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    });

    // Read each referenced file or directory
    for (const ref of uniqueRefs) {
      const cleanRef = ref.endsWith("/") ? ref.slice(0, -1) : ref;
      const resolvedPath = resolveRef(cleanRef, baseDir);

      if (!fs.existsSync(resolvedPath)) {
        console.warn(`[pi-file-reference] @${cleanRef} -> ${resolvedPath} not found, skipping`);
        continue;
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
        if (files.length === 0) {
          console.warn(`[pi-file-reference] @${cleanRef} is an empty directory, skipping`);
          continue;
        }
        for (const fileName of files) {
          const filePath = path.join(resolvedPath, fileName);
          results.push({
            ref: `${cleanRef}/${fileName}`,
            resolvedPath: filePath,
            content: fs.readFileSync(filePath, "utf-8"),
          });
        }
      } else {
        results.push({ ref: cleanRef, resolvedPath, content: fs.readFileSync(resolvedPath, "utf-8") });
      }
    }
  }

  return results;
}
```

### Extension handlers (after change)

```typescript
let cachedRefs: RefContent[] = [];
let initialized = false;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    cachedRefs = [];
    initialized = false;
  });

  pi.on("before_agent_start", (event) => {
    if (!initialized) {
      cachedRefs = loadRefsFromPrompt(event.systemPrompt);
      initialized = true;
    }

    if (!cachedRefs.length) return;

    const blocks = cachedRefs
      .map(
        (r) =>
          `<project_reference path="${r.resolvedPath}">\n${r.content}\n</project_reference>`,
      )
      .join("\n\n");

    // Inject inside <project_context> before </project_context>
    const closeTag = "</project_context>";
    const closeIdx = event.systemPrompt.lastIndexOf(closeTag);

    if (closeIdx !== -1) {
      const prefix = event.systemPrompt.slice(0, closeIdx);
      const suffix = event.systemPrompt.slice(closeIdx);
      return { systemPrompt: prefix + blocks + "\n\n" + suffix };
    }

    // Fallback: no <project_context> (custom prompt)
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n<project_context>\n\n${blocks}\n\n</project_context>`,
    };
  });
}
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

<project_reference path="/Users/joseph/projects/.../README.md">
{README content}
</project_reference>

<project_reference path="/Users/joseph/.agents/skills/karpathy-guidelines/SKILL.md">
{karpathy content}
</project_reference>

</project_context>
```

Clear separation: `<project_instructions>` = Pi's own context files; `<project_reference>` = extension-resolved @refs.

## Files Changed

| File | Change |
|------|--------|
| `extensions/index.ts` | Remove `loadRefs()`, `AGENTS_FILE`; add `loadRefsFromPrompt()`; update handlers; rename injection tag |
| `extensions/index.test.ts` | Update tests for new function signature and tag name |

LOCs: net reduction (no hardcoded paths, no context file filtering, reuses `parseRefs` and `resolveRef` helpers).

## Test Plan

Same flow: implement → `pi install .` → `/reload` → send prompt → `/export` → verify.

### Test Assertions

1. `<project_context>` contains 2 `<project_instructions>` (Pi's AGENTS.md) + 2 `<project_reference>` (extension-refs) = 4 blocks total
2. Extension blocks use `<project_reference>` tag (not `<project_instructions>`)
3. Paths: `README.md` and `karpathy-guidelines/SKILL.md` resolved and injected
4. Cache works: second prompt also has injected blocks

### Test Command

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
ref_count = ctx_block.count('<project_reference path=')
assert instr_count >= 2, f'Expected >= 2 <project_instructions>, got {instr_count}'
assert ref_count >= 2, f'Expected >= 2 <project_reference>, got {ref_count}'

paths = re.findall(r'<project_reference path=\"([^\"]+)\">', ctx_block)
assert any('README.md' in p for p in paths), 'README.md not injected'
assert any('karpathy-guidelines' in p for p in paths), 'karpathy not injected'

print(f'OK: {instr_count} instructions + {ref_count} references inside <project_context>')
for p in paths:
    print(f'  ref: {p}')
print('PASS')
"
```

### Expected Output

```
OK: 2 instructions + 2 references inside <project_context>
  ref: /Users/joseph/projects/personal/pi-pacakges/pi-file-reference/README.md
  ref: /Users/joseph/.agents/skills/karpathy-guidelines/SKILL.md
PASS
```
