import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Parse @filepath references from a line.
 *
 * Rules:
 * - @ must be preceded by whitespace or start-of-line
 * - @ followed by a double-quoted string: extract inside quotes
 * - @ followed by unquoted text: extract until whitespace
 * - Only .md and .mdc file extensions are accepted
 */
export function parseRefs(line: string): string[] {
  const refs: string[] = [];
  let i = 0;

  while (i < line.length) {
    const atIdx = line.indexOf("@", i);
    if (atIdx === -1) break;

    // @ must be preceded by start-of-line or whitespace
    if (atIdx > 0 && line[atIdx - 1] !== " " && line[atIdx - 1] !== "\t") {
      i = atIdx + 1;
      continue;
    }

    i = atIdx + 1;
    let ref: string;

    if (line[i] === '"') {
      // Quoted reference: @"path/to/file"
      const close = line.indexOf('"', i + 1);
      ref = close === -1 ? line.slice(i + 1) : line.slice(i + 1, close);
      i = close === -1 ? line.length : close + 1;
    } else {
      // Unquoted reference: @path/to/file (until whitespace)
      const start = i;
      while (i < line.length && !/\s/.test(line[i])) i++;
      ref = line.slice(start, i);
    }

    if (ref && (ref.includes("/") || ref.includes("."))) {
      // Only allow .md/.mdc file extensions; pass through paths with no
      // extension in the last segment (they may be directories).
      const lastSeg = ref.split("/").pop()!;
      const dotIdx = lastSeg.lastIndexOf(".");
      if (dotIdx !== -1) {
        const ext = lastSeg.slice(dotIdx);
        if (ext !== ".md" && ext !== ".mdc") continue;
      }
      refs.push(ref);
    }
  }

  return refs;
}

/**
 * Resolve a reference path against baseDir.
 *
 * Handles:
 * - Absolute paths (/foo/bar) — used as-is
 * - Tilde paths (~/foo or ~user/foo) — expanded via os.homedir()
 * - Relative paths — resolved against baseDir
 */
export function resolveRef(ref: string, baseDir: string): string {
  if (ref.startsWith("/")) return ref;
  if (ref.startsWith("~")) {
    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1) {
      return path.join(os.homedir(), ref.slice(1));
    }
    const userPart = ref.slice(1, slashIdx);
    if (!userPart) {
      return path.join(os.homedir(), ref.slice(slashIdx + 1));
    }
    return path.join(os.homedir(), userPart, ref.slice(slashIdx + 1));
  }
  return path.resolve(baseDir, ref);
}

/** A resolved file with its content. */
export interface RefContent {
  path: string;
  content: string;
}

const MAX_SIZE = 100 * 1024; // 100KB per file

/**
 * Collect all resolved file paths from context file @refs.
 *
 * Parses refs, deduplicates, resolves paths, expands directories,
 * and filters by extension (.md/.mdc), dot-files, and size (100KB).
 */
export function getAllFilePathFromContextFiles(
  contextFiles: Array<{ path: string; content: string }>,
): string[] {
  const seen = new Set<string>();
  const resolvedPaths: string[] = [];

  for (const { path: filePath, content } of contextFiles) {
    const baseDir = path.dirname(filePath);

    const allRefs: string[] = [];
    for (const line of content.split("\n")) {
      allRefs.push(...parseRefs(line));
    }

    const uniqueRefs = allRefs.filter((ref) => {
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    });

    for (const ref of uniqueRefs) {
      const cleanRef = ref.endsWith("/") ? ref.slice(0, -1) : ref;
      const resolvedPath = resolveRef(cleanRef, baseDir);

      if (!fs.existsSync(resolvedPath)) {
        console.warn(
          `[pi-file-reference] @${cleanRef} -> ${resolvedPath} not found, skipping`,
        );
        continue;
      }

      const stat = fs.statSync(resolvedPath);

      if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const files = entries
          .filter((e) => {
            if (!e.isFile()) return false;
            if (e.name.startsWith(".")) return false;
            const ext = path.extname(e.name);
            return ext === ".md" || ext === ".mdc";
          })
          .map((e) => e.name)
          .sort();

        for (const fileName of files) {
          const filePath = path.join(resolvedPath, fileName);
          const fileStat = fs.statSync(filePath);
          if (fileStat.size > MAX_SIZE) {
            console.warn(
              `[pi-file-reference] ${filePath} exceeds 100KB limit, skipping`,
            );
            continue;
          }
          resolvedPaths.push(filePath);
        }
      } else {
        if (stat.size > MAX_SIZE) {
          console.warn(
            `[pi-file-reference] ${resolvedPath} exceeds 100KB limit, skipping`,
          );
          continue;
        }
        resolvedPaths.push(resolvedPath);
      }
    }
  }

  return resolvedPaths;
}

/**
 * Read file contents for a list of resolved paths.
 */
export function parseFileAndContent(paths: string[]): RefContent[] {
  return paths.map((resolvedPath) => ({
    path: resolvedPath,
    content: fs.readFileSync(resolvedPath, "utf-8"),
  }));
}

/**
 * Inject resolved references into the system prompt.
 *
 * Inserts <project_references> blocks before </project_context>.
 * Falls back to appending a new <project_context> block if the tag is absent.
 */
export function inject(contents: RefContent[], systemPrompt: string): string {
  if (!contents.length) return systemPrompt;

  const blocks = contents
    .map(
      (r) =>
        `<project_references path="${r.path}">\n${r.content}\n</project_references>`,
    )
    .join("\n\n");

  const closeTag = "</project_context>";
  const closeIdx = systemPrompt.lastIndexOf(closeTag);

  if (closeIdx !== -1) {
    const prefix = systemPrompt.slice(0, closeIdx);
    const suffix = systemPrompt.slice(closeIdx);
    return prefix + blocks + "\n\n" + suffix;
  }

  return systemPrompt + `\n\n<project_context>\n\n${blocks}\n\n</project_context>`;
}

// --- Hook ---

let cachedPaths: string[] = [];
let cachedContents: RefContent[] = [];
let initialized = false;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    cachedPaths = [];
    cachedContents = [];
    initialized = false;
  });

  pi.on("before_agent_start", (event) => {
    if (!initialized) {
      cachedPaths = getAllFilePathFromContextFiles(
        event.systemPromptOptions.contextFiles ?? [],
      );
      cachedContents = parseFileAndContent(cachedPaths);
      initialized = true;
    }

    const newPrompt = inject(cachedContents, event.systemPrompt);
    if (newPrompt !== event.systemPrompt) {
      return { systemPrompt: newPrompt };
    }
  });
}
