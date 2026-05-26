# System Prompt Injection & Caching Strategy

## Context

`pi-file-reference` injects resolved `@filepath` references into the system prompt during `before_agent_start`. This document captures decisions around injection location, caching, and LLM prompt cache friendliness.

## System Prompt Structure

Pi's `buildSystemPrompt` (internal, not exposed to extensions) produces:

```
[default header: "You are an expert coding assistant..."]
[appendSystemPrompt]
<project_context>
  <project_instructions path="...">
    AGENTS.md content
  </project_instructions>
</project_context>
[skills section]
Current date: ...
Current working directory: ...
```

Extensions receive the rendered string as `event.systemPrompt` and can replace it via return:

```ts
interface BeforeAgentStartEventResult {
    message?: Pick<CustomMessage, ...>;
    systemPrompt?: string;  // full replacement, chained across extensions
}
```

## Injection Location: Inside `<project_context>`

**Decision**: Inject before `</project_context>`, with fallback to appending at end of prompt.

**Rationale**:

| Strategy | Semantics | Robustness |
|----------|-----------|------------|
| Before `</project_context>` | ✅ References are project context material | Requires tag to exist |
| End of prompt | ❌ Mixed with tools/guidelines | No dependencies |

The fallback handles custom prompts where the tag might be absent.

## Caching Strategy

### Session-level cache (current)

```ts
let cachedRefs: RefContent[] = [];
let initialized = false;

pi.on("session_start", () => {
  cachedRefs = [];
  initialized = false;
});

pi.on("before_agent_start", (event) => {
  if (!initialized) {
    cachedRefs = loadRefsFromContextFiles(
      event.systemPromptOptions.contextFiles ?? [],
    );
    initialized = true;
  }
  // Inject cachedRefs into event.systemPrompt
});
```

**Properties**:
- File contents read once per session → injected bytes identical every turn
- `session_start` resets → new session loads fresh content
- LLM prompt caching works: identical system prompt bytes across turns within a session

### Alternative considered: hash-checked full prompt cache

Cache the complete post-injection system prompt along with a hash of the raw `event.systemPrompt`. On subsequent turns, hash the raw prompt, compare, and return the cached full prompt if unchanged.

**Verdict: Not adopted.** Both approaches are O(n) per turn (~50KB system prompt). `lastIndexOf` + string concatenation is memcpy-level cheap; SHA256 adds CPU overhead with no observable benefit. Identical byte output is already guaranteed by the session-level file cache. Extra branch and state add complexity for zero gain.

## LLM Prompt Cache Friendliness

| Concern | Status |
|---------|--------|
| Injected content changes between turns | ✅ No — cached per session |
| Injection position drifts between turns | ✅ No — `lastIndexOf` is deterministic for same input |
| Other extensions mutate system prompt non-deterministically | ⚠️ Possible — pi-file-reference sees whatever upstream handlers produced |

The only cache-invalidation risk is other extensions producing varying output. This is outside our control and rare in practice.

## API Surface Used

- `event.systemPrompt` — the rendered system prompt (string, modified by chaining)
- `event.systemPromptOptions.contextFiles` — AGENTS.md and other context files (structured, read-only)
- `event.systemPromptOptions.cwd` — working directory for path resolution

`buildSystemPrompt` is **not** part of the public API. It is not exported from the package's entry point or any exposed subpath. Extensions cannot reconstruct the prompt from structured options — string manipulation on the rendered output is the intended extension mechanism.
