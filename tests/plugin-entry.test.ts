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
 * The opt-in load probe (root+marker env vars, validated writes) is covered
 * in tests/plugin-probe.test.ts; this file only locks the loader-safe shape.
 */
import { describe, expect, test } from "bun:test";
import { AntigravityTaskPlugin } from "../src/index";
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
