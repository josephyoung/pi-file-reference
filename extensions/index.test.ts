import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  parseRefs,
  resolveRef,
  loadRefsFromContextFiles,
  type RefContent,
} from "./index.ts";

// ---------------------------------------------------------------------------
// parseRefs
// ---------------------------------------------------------------------------
describe("parseRefs", () => {
  it("extracts @ref at start of line", () => {
    assert.deepEqual(parseRefs("@path/to/file.md"), ["path/to/file.md"]);
  });

  it("extracts @ref after space", () => {
    assert.deepEqual(parseRefs("  @path/to/file.md"), ["path/to/file.md"]);
  });

  it("extracts @ref after tab", () => {
    assert.deepEqual(parseRefs("\t@path/to/file.md"), ["path/to/file.md"]);
  });

  it("extracts @ref mid-line after space", () => {
    assert.deepEqual(parseRefs("prefix content @path/to/file.md suffix"), [
      "path/to/file.md",
    ]);
  });

  it("extracts multiple @refs on one line", () => {
    assert.deepEqual(
      parseRefs("first @a.md and @b.md and @c/d/e.md"),
      ["a.md", "b.md", "c/d/e.md"],
    );
  });

  it("extracts @ref at end of line without trailing whitespace", () => {
    assert.deepEqual(parseRefs("use @../guide.md"), ["../guide.md"]);
  });

  it("parses double-quoted @\"path with spaces\"", () => {
    assert.deepEqual(parseRefs('use @"path with spaces/file.md"'), [
      "path with spaces/file.md",
    ]);
  });

  it("parses multiple quoted refs", () => {
    assert.deepEqual(
      parseRefs('first @"a b.md" second @"c d.md"'),
      ["a b.md", "c d.md"],
    );
  });

  it("mixes quoted and unquoted refs", () => {
    assert.deepEqual(
      parseRefs('@simple.md and @"complex name.md"'),
      ["simple.md", "complex name.md"],
    );
  });

  it("ignores @ in middle of a word (no preceding whitespace)", () => {
    assert.deepEqual(parseRefs("some@ref"), []);
  });

  it("ignores @ preceded by non-whitespace character", () => {
    assert.deepEqual(parseRefs("prefix@ref.md"), []);
  });

  it("returns empty for line with no @", () => {
    assert.deepEqual(parseRefs("no references here"), []);
  });

  it("returns empty for empty line", () => {
    assert.deepEqual(parseRefs(""), []);
  });

  it("ignores @words that don't look like file paths (no / or .)", () => {
    assert.deepEqual(parseRefs("@filepath and @refs, are documentation"), []);
  });

  it("matches @refs with a dot (file extension)", () => {
    assert.deepEqual(parseRefs("@file.md"), ["file.md"]);
  });

  it("matches @refs with a slash (directory or path)", () => {
    assert.deepEqual(parseRefs("@./docs"), ["./docs"]);
  });
});

// ---------------------------------------------------------------------------
// resolveRef
// ---------------------------------------------------------------------------
describe("resolveRef", () => {
  const baseDir = "/project/.pi";

  it("resolves relative path against baseDir", () => {
    assert.equal(resolveRef("./docs/file.md", baseDir), "/project/.pi/docs/file.md");
  });

  it("resolves relative path without ./ prefix", () => {
    assert.equal(resolveRef("docs/file.md", baseDir), "/project/.pi/docs/file.md");
  });

  it("resolves relative path with ../", () => {
    assert.equal(resolveRef("../AGENTS.md", baseDir), "/project/AGENTS.md");
  });

  it("returns absolute paths unchanged", () => {
    assert.equal(resolveRef("/etc/config.md", baseDir), "/etc/config.md");
  });

  it("expands ~/ to homedir", () => {
    const home = os.homedir();
    assert.equal(resolveRef("~/config/notes.md", baseDir), `${home}/config/notes.md`);
  });

  it("expands ~user/ to homedir/user", () => {
    const home = os.homedir();
    assert.equal(resolveRef("~bob/notes.md", baseDir), `${home}/bob/notes.md`);
  });

  it("handles bare ~ with no path (edge case)", () => {
    const home = os.homedir();
    assert.equal(resolveRef("~", baseDir), home);
  });
});

// ---------------------------------------------------------------------------
// loadRefsFromContextFiles
// ---------------------------------------------------------------------------
describe("loadRefsFromContextFiles", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ref-test-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFile(relativePath: string, content = ""): string {
    const full = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    return full;
  }

  // --- empty / no-op cases ---

  it("returns empty array when contextFiles is empty", () => {
    const result = loadRefsFromContextFiles([]);
    assert.deepEqual(result, []);
  });

  it("returns empty array when context file has no @refs", () => {
    const agentsPath = path.join(tmpDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# Just a heading\n\nNo refs here.\n", "utf-8");
    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);
    assert.deepEqual(result, []);
  });

  it("processes ALL context file entries (no hardcoded filename filter)", () => {
    // CUSTOM.md with a @ref — should be processed (no AGENTS/CLAUDE guard)
    const refFile = createFile("custom-rules.md", "custom content");
    const customPath = path.join(tmpDir, "CUSTOM.md");
    fs.writeFileSync(customPath, "@custom-rules.md\n", "utf-8");
    const result = loadRefsFromContextFiles([
      { path: customPath, content: fs.readFileSync(customPath, "utf-8") },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].ref, "custom-rules.md");
  });

  // --- happy path ---

  it("resolves a single @ref to a file that exists", () => {
    const refFile = createFile("style-guide.md", "Use camelCase");
    const agentsPath = createFile("AGENTS.md", "Follow @style-guide.md\n");

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].ref, "style-guide.md");
    assert.equal(result[0].resolvedPath, refFile);
    assert.equal(result[0].content, "Use camelCase");
  });

  it("resolves multiple @refs in a single context file", () => {
    const fileA = createFile("a.md", "AAA");
    const fileB = createFile("sub/b.md", "BBB");
    const agentsPath = createFile("AGENTS.md", "use @a.md and @sub/b.md\n");

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);

    assert.equal(result.length, 2);
    const refs = result.map((r) => r.ref).sort();
    assert.deepEqual(refs, ["a.md", "sub/b.md"]);
    assert.equal(result.find((r) => r.ref === "a.md")!.content, "AAA");
    assert.equal(result.find((r) => r.ref === "sub/b.md")!.content, "BBB");
  });

  // --- directory refs ---

  it("resolves a directory @ref reading depth-1 files sorted", () => {
    const dir = path.join(tmpDir, "docs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "b.md"), "BBB", "utf-8");
    fs.writeFileSync(path.join(dir, "a.md"), "AAA", "utf-8");
    const subdir = path.join(dir, "sub");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, "c.md"), "CCC", "utf-8");

    const agentsPath = createFile("AGENTS.md", "@./docs\n");

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);

    assert.equal(result.length, 2);
    assert.equal(result[0].ref, "./docs/a.md");
    assert.equal(result[0].content, "AAA");
    assert.equal(result[1].ref, "./docs/b.md");
    assert.equal(result[1].content, "BBB");
  });

  it("skips directory @ref when directory is empty", () => {
    const emptyDir = path.join(tmpDir, "empty-dir");
    fs.mkdirSync(emptyDir, { recursive: true });

    const agentsPath = createFile("AGENTS.md", "@./empty-dir\n");

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);
    assert.deepEqual(result, []);
  });

  it("resolves directory @ref with trailing slash", () => {
    const dir = path.join(tmpDir, "stuff");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.md"), "XXX", "utf-8");

    const agentsPath = createFile("AGENTS.md", "@stuff/\n");

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0].ref, "stuff/x.md");
  });

  // --- missing file ---

  it("skips @ref pointing to a non-existent file", () => {
    const agentsPath = createFile("AGENTS.md", "@nonexistent.md\n");

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);
    assert.deepEqual(result, []);
  });

  // --- multiple context files ---

  it("collects refs from multiple context files", () => {
    const userDir = path.join(tmpDir, "user-pi-agent");
    fs.mkdirSync(userDir, { recursive: true });
    const userFile = path.join(userDir, "user-settings.md");
    fs.writeFileSync(userFile, "user config", "utf-8");
    const userAgents = path.join(userDir, "AGENTS.md");
    fs.writeFileSync(userAgents, "use @user-settings.md\n", "utf-8");

    const projFile = createFile("project-rules.md", "proj config");
    const projAgents = createFile("AGENTS.md", "use @project-rules.md\n");

    const result = loadRefsFromContextFiles([
      { path: projAgents, content: fs.readFileSync(projAgents, "utf-8") },
      { path: userAgents, content: fs.readFileSync(userAgents, "utf-8") },
    ]);

    assert.equal(result.length, 2);
    const refs = result.map((r) => r.ref).sort();
    assert.deepEqual(refs, ["project-rules.md", "user-settings.md"]);
  });

  it("deduplicates same @ref across context files (first occurrence wins)", () => {
    const dirA = path.join(tmpDir, "proj");
    const dirB = path.join(tmpDir, "user");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "guidelines.md"), "from proj", "utf-8");
    fs.writeFileSync(path.join(dirB, "guidelines.md"), "from user", "utf-8");

    const projAgents = path.join(dirA, "AGENTS.md");
    const userAgents = path.join(dirB, "AGENTS.md");
    fs.writeFileSync(projAgents, "@guidelines.md\n", "utf-8");
    fs.writeFileSync(userAgents, "@guidelines.md\n", "utf-8");

    const result = loadRefsFromContextFiles([
      { path: projAgents, content: fs.readFileSync(projAgents, "utf-8") },
      { path: userAgents, content: fs.readFileSync(userAgents, "utf-8") },
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].resolvedPath, path.join(dirA, "guidelines.md"));
    assert.equal(result[0].content, "from proj");
  });

  // --- absolute / tilde refs ---

  it("resolves absolute @ref paths", () => {
    const absPath = path.join(tmpDir, "absolute-ref.md");
    fs.writeFileSync(absPath, "abs content", "utf-8");

    const agentsPath = createFile("AGENTS.md", `@${absPath}\n`);

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].resolvedPath, absPath);
    assert.equal(result[0].content, "abs content");
  });

  it("resolves tilde ~/ @ref paths", () => {
    const home = os.homedir();
    const homeFile = path.join(home, ".pi-ref-test-temp-file.md");
    try {
      fs.writeFileSync(homeFile, "home content", "utf-8");

      const agentsPath = createFile("AGENTS.md", "@~/.pi-ref-test-temp-file.md\n");

      const result = loadRefsFromContextFiles([
        { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
      ]);

      assert.equal(result.length, 1);
      assert.equal(result[0].resolvedPath, homeFile);
      assert.equal(result[0].content, "home content");
    } finally {
      try { fs.rmSync(homeFile, { force: true }); } catch { /* ignore */ }
    }
  });

  // --- quoted paths ---

  it("handles quoted @\"path with spaces\" in context file content", () => {
    const spacedFile = createFile("my file.md", "spaced content");
    const agentsPath = createFile('AGENTS.md', '@"my file.md"\n');

    const result = loadRefsFromContextFiles([
      { path: agentsPath, content: fs.readFileSync(agentsPath, "utf-8") },
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].resolvedPath, spacedFile);
    assert.equal(result[0].content, "spaced content");
  });
});
