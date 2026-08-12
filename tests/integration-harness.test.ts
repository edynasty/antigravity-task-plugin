/**
 * Env/hash/config helper-contract tests for the isolated OpenCode loading
 * harness (Todo 6). The load-proof checker and hash-line formatting live in
 * tests/load-proof.test.ts; this file covers env building, hashing, config
 * writing, spec resolution, and packed-module loading. The real E2E gate runs
 * in tests/integration-harness.ts via `bun run test:integration`. Each file
 * stays <= 250 pure LOC.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildIsolatedOpenCodeEnv,
  hashFileOrAbsent,
  loadPluginFactory,
  packOutputFilename,
  specToPluginSpec,
  writeOpenCodeConfig,
} from "./helpers/integration-harness";

describe("integration harness helpers", () => {
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "antigravity-harness-test-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  describe("hashFileOrAbsent", () => {
    test("returns the sha256 hex digest of an existing file", async () => {
      const file = join(tempRoot, "digest.txt");
      await writeFile(file, "deterministic content");

      const digest = await hashFileOrAbsent(file);

      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    test("represents an absent file distinctly from any hash", async () => {
      const missing = join(tempRoot, "never-written.txt");

      const digest = await hashFileOrAbsent(missing);

      expect(digest).toBe("ABSENT");
      expect(digest).not.toMatch(/^[0-9a-f]{64}$/);
    });

    test("a later write to the same path changes the receipt", async () => {
      const file = join(tempRoot, "changing.txt");
      await writeFile(file, "first");

      const before = await hashFileOrAbsent(file);
      await writeFile(file, "second");
      const after = await hashFileOrAbsent(file);

      expect(before).not.toBe(after);
    });
  });

  describe("writeOpenCodeConfig", () => {
    test("writes $schema and the plugin array into the config file", async () => {
      const configDir = join(tempRoot, "config-a");
      await mkdir(configDir, { recursive: true });
      const spec = "file:///tmp/example-plugin/dist/index.js";

      const written = await writeOpenCodeConfig(configDir, [spec]);

      expect(written).toBe(join(configDir, "opencode.json"));
      const parsed = JSON.parse(await Bun.file(written).text()) as {
        $schema?: string;
        plugin?: readonly unknown[];
      };
      expect(parsed.$schema).toBe("https://opencode.ai/config.json");
      expect(parsed.plugin).toEqual([spec]);
    });

    test("preserves multiple specs in declaration order", async () => {
      const configDir = join(tempRoot, "config-b");
      await mkdir(configDir, { recursive: true });
      const specs = ["one", "two"];

      const written = await writeOpenCodeConfig(configDir, specs);

      const parsed = JSON.parse(await Bun.file(written).text()) as { plugin?: readonly unknown[] };
      expect(parsed.plugin).toEqual(specs);
    });
  });

  describe("specToPluginSpec", () => {
    test("turns a bare package name into the same bare spec", () => {
      expect(specToPluginSpec("some-plugin")).toBe("some-plugin");
    });

    test("keeps an absolute file URL unchanged", () => {
      const url = "file:///abs/path/dist/index.js";
      expect(specToPluginSpec(url)).toBe(url);
    });

    test("resolves a relative path to a file URL", () => {
      const resolved = specToPluginSpec("./probe.ts", "/tmp/home/config");
      expect(resolved).toBe(pathToFileURL("/tmp/home/config/probe.ts").href);
    });
  });

  describe("packOutputFilename", () => {
    test("extracts the tarball filename from npm pack output", () => {
      const output = "npm notice\nantigravity-task-plugin-0.0.0.tgz";
      expect(packOutputFilename(output)).toBe("antigravity-task-plugin-0.0.0.tgz");
    });
  });

  describe("loadPluginFactory", () => {
    test("instantiates a plugin module and returns exactly its tool keys", async () => {
      const entry = join(tempRoot, "mini-plugin.mjs");
      await writeFile(
        entry,
        'export const AntigravityTaskPlugin = async () => ({ tool: { "mini-tool": {} } });\n' +
          "export default AntigravityTaskPlugin;\n",
      );

      const loaded = await loadPluginFactory(pathToFileURL(entry).href);

      expect(loaded.defaultIsFunction).toBe(true);
      expect(loaded.namedIsFunction).toBe(true);
      expect(loaded.toolKeys).toEqual(["mini-tool"]);
    });

    test("fails with an actionable error for a nonexistent module", async () => {
      const missing = pathToFileURL(join(tempRoot, "does-not-exist.mjs")).href;

      expect(loadPluginFactory(missing)).rejects.toThrow(/Cannot find module|no such file/i);
    });
  });
});

describe("buildIsolatedOpenCodeEnv", () => {
  const seed = {
    home: "/tmp/h",
    configDir: "/tmp/h/.config",
    configFile: "/tmp/opencode.json",
    data: "/tmp/d",
    cache: "/tmp/c",
    state: "/tmp/s",
    workDir: "/tmp/w",
  };

  test("hostile parent TMPDIR cannot override the generated seed tmp dir", () => {
    const child = buildIsolatedOpenCodeEnv(
      { ...seed, tmpDirOverride: "/private/var/example/generated-tmp" },
      { PATH: "/usr/bin:/bin", TMPDIR: "/evil/tmp" },
    );

    expect(child["TMPDIR"]).toBe("/private/var/example/generated-tmp");
  });

  test("probe vars come only from the seed, never inherited from the parent", () => {
    const child = buildIsolatedOpenCodeEnv(
      {
        ...seed,
        probeRootPath: "/tmp/gen-root",
        probeMarkerPath: "/tmp/gen-root/load-probe.marker",
        probeNonce: "a".repeat(32),
      },
      {
        ANTIGRAVITY_TASK_PLUGIN_ROOT: "/evil/root",
        ANTIGRAVITY_TASK_PLUGIN_MARKER: "/evil/marker",
        ANTIGRAVITY_TASK_PLUGIN_NONCE: "evil",
      },
    );

    expect(child["ANTIGRAVITY_TASK_PLUGIN_ROOT"]).toBe("/tmp/gen-root");
    expect(child["ANTIGRAVITY_TASK_PLUGIN_MARKER"]).toBe("/tmp/gen-root/load-probe.marker");
    expect(child["ANTIGRAVITY_TASK_PLUGIN_NONCE"]).toBe("a".repeat(32));
  });
});

