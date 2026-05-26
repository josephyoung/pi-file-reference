# Plan: Refactor + filter to .md/.mdc only, exclude dot-files in directories

## Goal

Refactor `loadRefsFromContextFiles()` into a clear 3-step pipeline, then narrow the extension to only resolve `.md` and `.mdc` files. Non-markdown file refs are dropped at parse time. Dot-files inside referenced directories are dropped.

---

## New pipeline

```
contextFiles[] → string[] → RefContent[] → systemPrompt
```

| Step | Function | Input | Output |
|------|----------|-------|--------|
| 1 | `getAllFilePathFromContextFiles` | `contextFiles[]` | `string[]` — resolved, deduplicated, filtered file paths |
| 2 | `parseFileAndContent` | `string[]` | `RefContent[]` |
| 3 | `inject` | `RefContent[]`, `systemPrompt` | modified `systemPrompt` |

Split at the I/O boundary: Step 1 does all file-system discovery (`existsSync`, `readdirSync`); Step 2 does pure reads (`readFileSync`); Step 3 does string manipulation.

### Step 1: `getAllFilePathFromContextFiles(contextFiles) → string[]`

```
for each contextFile:
  baseDir = dirname(filePath)
  refs = flatMap(lines, parseRefs)          // parse + .md/.mdc filter
  uniqueRefs = dedupe(refs, seen)           // deduplicate
  for each ref:
    resolved = resolveRef(ref, baseDir)     // resolve path
    exists? → no → warn, skip
    isDir? → readdir, filter .md/.mdc + exclude dot-files, add each resolved
    isFile? → add resolved
return flat resolved paths[]
```

### Step 2: `parseFileAndContent(paths) → RefContent[]`

```
for each path:
  content = readFileSync(path, "utf-8")
  push { path, content }
```

### Step 3: `inject(contents, prompt) → prompt`

Current inline logic, extracted:

```
blocks = contents.map(r => `<project_references path="...">\n${r.content}\n</project_references>`).join("\n\n")
insert before </project_context>; fallback: append to prompt
```

### Hook

```ts
const paths = getAllFilePathFromContextFiles(contextFiles);
const contents = parseFileAndContent(paths);
return inject(contents, systemPrompt);
```

---

## Extension filtering

### `parseRefs()` — drop non-.md/.mdc at parse time

Current:
```ts
if (ref && (ref.includes("/") || ref.includes("."))) refs.push(ref);
```

New: only push if the last path segment either has no extension (directory) or ends with `.md`/`.mdc`:

```ts
if (!ref) continue;
if (ref.includes("/") || ref.includes(".")) {
  const lastSeg = ref.split("/").pop()!;
  const dotIdx = lastSeg.lastIndexOf(".");
  if (dotIdx !== -1) {
    const ext = lastSeg.slice(dotIdx);
    if (ext !== ".md" && ext !== ".mdc") continue;
  }
  refs.push(ref);
}
```

### Directory expansion in `getAllFilePathFromContextFiles`

readdir filter: `isFile`, `!name.startsWith(".")`, `extname` is `.md` or `.mdc`.

### Per-file size limit

Skip files larger than **100KB**. Checked via the existing `statSync` result — `stat.size` is already available, no extra I/O.

```ts
if (stat.size > 100 * 1024) {
  console.warn(`[pi-file-reference] ${resolvedPath} exceeds 100KB limit, skipping`);
  continue;
}
```

Applies to both direct file refs and directory expansion. ~25K tokens per file — room for thorough docs without dominating the prompt.

---

## `RefContent` shape

Drop `ref` — only `resolvedPath` was consumed downstream. With the new pipeline, only resolved paths flow through:

```ts
// Before
export interface RefContent {
  ref: string;
  resolvedPath: string;
  content: string;
}

// After
export interface RefContent {
  path: string;
  content: string;
}
```

Update `inject` to use `r.path` instead of `r.resolvedPath`.

---

## Changes to `extensions/index.test.ts`

### New `parseRefs` tests

| Test | Input | Expected |
|------|-------|----------|
| `.md` passes | `@guide.md` | `["guide.md"]` |
| `.mdc` passes | `@rules.mdc` | `["rules.mdc"]` |
| `.txt` dropped | `@notes.txt` | `[]` |
| `.png` dropped | `@img.png` | `[]` |
| no extension passes (directory) | `@./docs` | `["./docs"]` |
| path with `.md` dir, `.txt` last segment | `@./md/stuff.txt` | `[]` |

### New `getAllFilePathFromContextFiles` tests

| Test | Input | Expected |
|------|-------|----------|
| `.md` ref resolves to file | `@guide.md` context, `guide.md` exists | path to `guide.md` |
| `.txt` ref is dropped at parse time | `@notes.txt` context, `notes.txt` exists | `[]` |
| dir ref: skips `.txt`, keeps `.md` | `@./docs`, dir with `a.md`, `b.txt` | path to `a.md` only |
| dir ref: skips dot-files | `@./docs`, dir with `readme.md`, `.hidden.md` | path to `readme.md` only |
| dir ref: all filtered → empty | `@./docs`, dir with `notes.txt`, `.gitkeep` | `[]` |
| file > 100KB skipped | `@big.md`, file size 120KB | `[]` |
| file ≤ 100KB passes | `@small.md`, file size 50KB | path to `small.md` |
| dir: large file skipped, small kept | `@./docs`, dir with `a.md` (80KB), `b.md` (150KB) | path to `a.md` only |

Existing tests adapt to the new function signatures as needed.

---

## TDD implementation flow

### Planning (done)

Interfaces decided: `getAllFilePathFromContextFiles`, `parseFileAndContent`, `inject`, `RefContent({path, content})`.

### RED-GREEN cycles (one behavior per cycle)

| # | Cycle | Behavior |
|---|-------|----------|
| 1 | RED→GREEN | `parseRefs()` drops non-`.md`/`.mdc` extensions |
| 2 | RED→GREEN | Directory expansion filters to `.md`/`.mdc` only |
| 3 | RED→GREEN | Directory expansion excludes dot-files (`.*`) |
| 4 | RED→GREEN | Per-file size limit (100KB) |

Each cycle: write one test → see it fail → write minimal code → see it pass. Write tests against the current module structure (don't pre-refactor). Don't write the next test until the current one is green.

### Refactor

After all 4 behaviors pass against the existing `loadRefsFromContextFiles` + hook structure:

1. Extract `inject()` from the hook body → run tests
2. Extract `parseFileAndContent()` → run tests
3. Extract `getAllFilePathFromContextFiles()` → run tests
4. Simplify `RefContent`: `ref` + `resolvedPath` → `path` → run tests
5. Wire hook with the 3-function pipeline → run tests

### Polish

- README: update docs
- `package.json`: version bump (suspense — separate publish step)
