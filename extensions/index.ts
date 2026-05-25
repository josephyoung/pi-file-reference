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

    if (ref) refs.push(ref);
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
    // ~/path or ~user/path
    const slashIdx = ref.indexOf("/");
    if (slashIdx === -1) {
      // Just ~ or ~user — unlikely, but handle gracefully
      return path.join(os.homedir(), ref.slice(1));
    }
    const userPart = ref.slice(1, slashIdx);
    if (!userPart) {
      // ~/path
      return path.join(os.homedir(), ref.slice(slashIdx + 1));
    }
    // ~user/ — tilde expansion for other users; falls back to homedir + user
    return path.join(os.homedir(), userPart, ref.slice(slashIdx + 1));
  }
  return path.resolve(baseDir, ref);
}

/** A resolved file reference with its content. */
export interface RefContent {
  ref: string;
  resolvedPath: string;
  content: string;
}

/**
 * Collect @filepath references from <project_instructions> blocks
 * inside Pi's <project_context> section of the system prompt.
 *
 * Processes all <project_instructions> blocks — no hardcoded filenames.
 * References are deduplicated across all blocks.
 */
export function loadRefsFromPrompt(systemPrompt: string): RefContent[] {
  // Extract <project_context> section
  const ctxStart = systemPrompt.indexOf("<project_context>");
  const ctxEnd = systemPrompt.indexOf("</project_context>");
  if (ctxStart === -1 || ctxEnd === -1) return [];

  const contextSection = systemPrompt.slice(ctxStart, ctxEnd);

  const seen = new Set<string>();
  const results: RefContent[] = [];

  // Parse all <project_instructions path="..."> blocks
  const instrRe =
    /<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g;
  let match: RegExpExecArray | null;

  while ((match = instrRe.exec(contextSection)) !== null) {
    const instrPath = match[1];
    const content = match[2];
    const baseDir = path.dirname(instrPath);

    // Collect all refs from all lines
    const allRefs: string[] = [];
    for (const line of content.split("\n")) {
      allRefs.push(...parseRefs(line));
    }

    // Deduplicate while preserving order (across all blocks)
    const uniqueRefs = allRefs.filter((ref) => {
      if (seen.has(ref)) return false;
      seen.add(ref);
      return true;
    });

    // Read each referenced file or directory (baseDir is per block)
    for (const ref of uniqueRefs) {
      // Strip trailing slashes for consistent handling
      const cleanRef = ref.endsWith("/") ? ref.slice(0, -1) : ref;
      const resolvedPath = resolveRef(cleanRef, baseDir);

      if (!fs.existsSync(resolvedPath)) {
        console.warn(`[pi-file-reference] @${cleanRef} -> ${resolvedPath} not found, skipping`);
        continue;
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        // Read all files at depth 1, skip subdirectories
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .sort(); // deterministic order

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
        results.push({
          ref: cleanRef,
          resolvedPath,
          content: fs.readFileSync(resolvedPath, "utf-8"),
        });
      }
    }
  }

  return results;
}

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

    // Inject inside <project_context> after existing <project_instructions>
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
