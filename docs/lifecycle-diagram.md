# Pi Lifecycle & pi-file-reference Injection Flow

```text
┌─────────────────────────────────────────────────────────────────────┐
│                           Pi Startup                                │
│  Load extensions, discover context files (AGENTS.md, CLAUDE.md)    │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  buildSystemPrompt(systemPromptOptions)                              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  event.systemPromptOptions:                                   │    │
│  │    contextFiles: [                                            │    │
│  │      { path: "AGENTS.md", content: "@./docs/guide.md\n..." }  │    │
│  │    ]                                                          │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│                              ▼                                       │
│  Rendered systemPrompt:                                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  <project_context>                                            │    │
│  │    <project_instructions path="AGENTS.md">                    │    │
│  │      @./docs/guide.md                                        │    │
│  │    </project_instructions>                                   │    │
│  │  </project_context>                                           │    │
│  │  <system_reminder>...</system_reminder>                       │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  session_start                                                       │
│                                                                      │
│  pi-file-reference:  cachedRefs = []   initialized = false           │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
   [User prompt]             [User prompt]              [User prompt]
        │                          │                          │
        ▼                          ▼                          ▼
┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
│before_agent_start │   │before_agent_start │   │before_agent_start │
│                   │   │                   │   │                   │
│ initialized=false │   │ initialized=true  │   │ initialized=true  │
│                   │   │                   │   │                   │
│ 1. parse @refs    │   │ reuse cachedRefs  │   │ reuse cachedRefs  │
│    from context   │   │                   │   │                   │
│    files          │   │ inject into       │   │ inject into       │
│                   │   │ systemPrompt      │   │ systemPrompt      │
│ 2. read files     │   │                   │   │                   │
│    from disk      │   │                   │   │                   │
│                   │   │                   │   │                   │
│ 3. cache contents │   │                   │   │                   │
│                   │   │                   │   │                   │
│ 4. inject into    │   │                   │   │                   │
│    systemPrompt   │   │                   │   │                   │
└───────┬───────────┘   └───────┬───────────┘   └───────┬───────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Final systemPrompt sent to LLM                                       │
│                                                                        │
│  <project_context>                                                     │
│    <project_instructions path="AGENTS.md">...                          │
│                                                                        │
│    <project_references path="/docs/guide.md">          ← injected      │
│      # Style Guide                                                     │
│      ...                                                               │
│    </project_references>                                               │
│  </project_context>                                                    │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Agent Loop                                                          │
│   ┌──► LLM call ──► tool calls ──► turn_end ──┐                     │
│   │                                            │                     │
│   └──────────── (repeat until done) ───────────┘                     │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│  session_start (new session / reload)                                 │
│                                                                      │
│  pi-file-reference:  cachedRefs = []   initialized = false           │
│  ↳ Next before_agent_start will re-read files from disk              │
└──────────────────────────────────────────────────────────────────────┘
```

| Symbol | Meaning |
|--------|---------|
| `──── session scope` | Cache lives for entire session |
| `──── byte-identical` | Same systemPrompt bytes every turn → LLM cache hits |
