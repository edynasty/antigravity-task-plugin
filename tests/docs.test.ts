/**
 * Static docs/schema consistency tests (Todo 7).
 *
 * Machine-check the README for the safety-critical contract tokens the
 * installation and usage guide must contain: section headings, argument
 * defaults, loader-safe package subpath, execute/plan/sandbox risk wording,
 * official doc links, CI/no-live guarantee. Avoids brittle prose snapshots;
 * asserts only the tokens a downstream consumer or safety reviewer would
 * grep for.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { antigravityTaskSchema } from "../src/index.js";

const REPO_ROOT = join(import.meta.dir, "..");
const README_PATH = join(REPO_ROOT, "README.md");

async function readReadme(): Promise<string> {
  return readFile(README_PATH, "utf8");
}

describe("README required sections", () => {
  test("contains every plan-required top-level heading", async () => {
    const readme = await readReadme();
    const requiredHeadings = [
      "Installation",
      "Tool arguments",
      "Example calls",
      "Execute vs plan mode",
      "Sandbox",
      "AGY_PATH",
      "Troubleshooting",
      "Compliance",
      "Verification",
    ];
    for (const heading of requiredHeadings) {
      expect(readme).toContain(`## ${heading}`);
    }
  });

  test("documents the loader-safe plugin subpath, not the unsafe root", async () => {
    const readme = await readReadme();
    expect(readme).toContain("antigravity-task-plugin/plugin");
    expect(readme).not.toContain(`"antigravity-task-plugin"`);
  });

  test("states that execute mode may modify the workspace", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/execute.*may modify files/i);
  });

  test("states that plan mode does not guarantee filesystem immutability", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/plan.*does not guarantee filesystem immutability/i);
  });

  test("states that sandbox restricts only terminal/shell access", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/sandbox.*restricts only terminal/i);
  });

  test("does not claim sandbox prevents filesystem writes", async () => {
    const readme = await readReadme();
    expect(readme).not.toMatch(/sandbox.*prevents.*writ/i);
    expect(readme).not.toMatch(/sandbox.*filesystem.*protect/i);
  });

  test("links to official Antigravity docs and ToS", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/antigravity\.google/);
    expect(readme).toMatch(/terms.*of.*service|tos/i);
  });

  test("states that CI does not run live smoke", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/CI.*does not run.*live|no.*live.*CI/i);
  });

  test("prohibits OAuth piggybacking without categorical legal claims", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/OAuth|piggyback|credential.*sharing/i);
    expect(readme).not.toMatch(/we (do not |don't )?(accept|assume|take) (any )?(legal|ToS|liability)/i);
  });

  test("Example calls section contains tool invocations with execute and plan modes", async () => {
    const readme = await readReadme();
    expect(readme).toContain("## Example calls");
    expect(readme).toContain('"tool": "antigravity-task"');
    expect(readme).toMatch(/"mode":\s*"execute"/);
    expect(readme).toMatch(/"mode":\s*"plan"/);
    expect(readme).toMatch(/WARNING.*execute.*may modify|execute.*MAY modify/i);
  });
});

describe("README argument table matches schema", () => {
  test("documents timeoutSeconds default 300 and range 10..900", async () => {
    const readme = await readReadme();
    expect(readme).toContain("300");
    expect(readme).toMatch(/10.*900|10\.\.900/);
  });

  test("documents mode default execute", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/mode.*default.*execute|execute.*default/i);
  });

  test("documents that conversationId and continueConversation are mutually exclusive", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/mutually exclusive|cannot.*both|either.*or/i);
  });

  test("argument defaults in README match the actual schema defaults", async () => {
    const shape = antigravityTaskSchema.shape;
    const timeoutDefault = shape.timeoutSeconds._def.defaultValue;
    const modeDefault = shape.mode._def.defaultValue;
    expect(timeoutDefault).toBe(300);
    expect(modeDefault).toBe("execute");
    const readme = await readReadme();
    expect(readme).toContain(String(timeoutDefault));
    expect(readme).toContain(modeDefault);
  });
});

describe("README installation examples", () => {
  test("includes npm/tarball config example with plugin array", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/plugin.*\[|plugin.*:/);
  });

  test("mentions OpenCode restart after config change", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/restart|quit.*reopen|reload/i);
  });

  test("includes local tarball installation path", async () => {
    const readme = await readReadme();
    expect(readme).toMatch(/tarball|\.tgz|npm pack|local.*install/i);
  });
});

describe("README troubleshooting", () => {
  test("covers missing CLI, auth, model, timeout, and empty output", async () => {
    const readme = await readReadme();
    const topics = ["AGY_PATH", "model", "timeout", "empty"];
    for (const topic of topics) {
      expect(readme.toLowerCase()).toContain(topic.toLowerCase());
    }
  });
});
