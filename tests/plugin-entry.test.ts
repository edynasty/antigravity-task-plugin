/**
 * Loader-safety regression tests for the dedicated plugin entry (Todo 6
 * blocker remediation). OpenCode 1.18.16's legacy plugin loader
 * (packages/opencode/src/plugin/index.ts getLegacyPlugins) iterates
 * Object.values(mod) and throws "Plugin export is not a function" for ANY
 * non-function export, then swallows the error (CLI still exits 0). The root
 * src/index.ts deliberately exports PACKAGE_IDENTITY and the schema object,
 * which are not functions, so plugin loading must go through a dedicated
 * entry that exposes ONLY callable plugin factory value(s).
 *
 * The entry also carries a narrow, opt-in load probe: when the integration
 * env var ANTIGRAVITY_TASK_PLUGIN_MARKER is set, the factory writes a fixed,
 * non-secret marker file atomically BEFORE delegating to the real plugin, so
 * the harness can prove the packed factory actually executed under OpenCode's
 * loader. Without the env var the entry performs zero probe I/O. The marker
 * contract lives in src/plugin-probe.ts (kept off the entry module so the
 * entry stays loader-safe).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AntigravityTaskPlugin } from "../src/index";
import { PLUGIN_LOAD_MARKER_CONTENT, PLUGIN_LOAD_MARKER_ENV } from "../src/plugin-probe";
import pluginEntry from "../src/plugin";

describe("dedicated plugin entry loader safety", () => {
  test("every export value of the plugin entry is a function", async () => {
    const mod = (await import("../src/plugin")) as Record<string, unknown>;
    const values = Object.values(mod);

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(typeof value, `export value must be a function, got ${typeof value}`).toBe("function");
    }
  });

  test("exposes exactly one unique plugin factory (no duplicate registration)", async () => {
    const mod = (await import("../src/plugin")) as Record<string, unknown>;
    const uniqueFunctions = new Set(Object.values(mod).filter((value): value is () => unknown => typeof value === "function"));

    expect(uniqueFunctions.size).toBe(1);
  });

  test("the dedicated entry default delegates to the root named factory", async () => {
    const hooks = await pluginEntry({} as never);
    expect(Object.keys(hooks.tool ?? {})).toEqual(["antigravity-task"]);
    expect(typeof pluginEntry).toBe("function");
    expect(AntigravityTaskPlugin).toBeTypeOf("function");
  });
});

describe("opt-in load probe marker", () => {
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "antigravity-probe-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("writes the fixed marker when the probe env var is set", async () => {
    const markerPath = join(tempRoot, "loaded.marker");
    const previous = process.env[PLUGIN_LOAD_MARKER_ENV];
    process.env[PLUGIN_LOAD_MARKER_ENV] = markerPath;
    try {
      await pluginEntry({} as never);
    } finally {
      if (previous === undefined) {
        delete process.env[PLUGIN_LOAD_MARKER_ENV];
      } else {
        process.env[PLUGIN_LOAD_MARKER_ENV] = previous;
      }
    }

    const marker = await readFile(markerPath, "utf8");
    expect(marker).toBe(PLUGIN_LOAD_MARKER_CONTENT);
  });

  test("performs zero probe I/O when the env var is absent", async () => {
    delete process.env[PLUGIN_LOAD_MARKER_ENV];
    const markerPath = join(tempRoot, "must-not-exist.marker");

    await pluginEntry({} as never);

    expect(readFile(markerPath, "utf8")).rejects.toThrow();
  });

  test("marker content is fixed, non-secret, and carries no timestamps", () => {
    expect(PLUGIN_LOAD_MARKER_CONTENT).toMatch(/^antigravity-task-plugin-factory-executed\n$/);
    expect(PLUGIN_LOAD_MARKER_CONTENT).not.toMatch(/(?<!ta)sk-[A-Za-z0-9]|Bearer\s|token\s*=|api[_-]?key\s*=|env\b|\.config/i);
  });
});
