import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AGENTS_FILE = "AGENTS.md";

/**
 * Parse @filepath references from a line.
 *
 * Rules:
 * - @ must be preceded by whitespace or start-of-line
 * - @ followed by a double-quoted string: extract inside quotes
 * - @ followed by unquoted text: extract until whitespace
 */
function parseRefs(line: string): string[] {
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
function resolveRef(ref: string, baseDir: string): string {
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
interface RefContent {
  ref: string;
  content: string;
}

/**
 * Find and parse AGENTS.md, collect @filepath references.
 *
 * Search order:
 * 1. <cwd>/AGENTS.md
 * 2. ~/.pi/agent/AGENTS.md
 */
function loadRefs(cwd: string): RefContent[] {
  const candidates = [
    path.join(cwd, AGENTS_FILE),
    path.join(os.homedir(), ".pi", "agent", AGENTS_FILE),
  ];

  let agentsPath: string | undefined;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      agentsPath = candidate;
      break;
    }
  }

  if (!agentsPath) return [];

  const raw = fs.readFileSync(agentsPath, "utf-8");
  const baseDir = path.dirname(agentsPath);

  // Collect all refs from all lines
  const allRefs: string[] = [];
  for (const line of raw.split("\n")) {
    allRefs.push(...parseRefs(line));
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const uniqueRefs = allRefs.filter((ref) => {
    if (seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });

  // Read each referenced file or directory
  const results: RefContent[] = [];
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
          content: fs.readFileSync(filePath, "utf-8"),
        });
      }
    } else {
      results.push({ ref: cleanRef, content: fs.readFileSync(resolvedPath, "utf-8") });
    }
  }

  return results;
}

let cachedRefs: RefContent[] = [];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    cachedRefs = loadRefs(ctx.cwd);
  });

  pi.on("before_agent_start", (event, _ctx) => {
    if (!cachedRefs.length) return;

    const injected = cachedRefs
      .map((r) => `## @${r.ref}\n\n${r.content}`)
      .join("\n\n");

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n# Context References\n\n${injected}`,
    };
  });
}
