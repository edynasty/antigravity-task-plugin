/**
 * Unit tests for the isolated OpenCode loading harness helpers (Todo 6).
 *
 * The real E2E gate (build -> pack -> extract -> import+instantiate -> debug
 * config/startup -> negative path -> live-config hash guard) runs in
 * tests/integration-harness.ts via `bun run test:integration`. These tests
 * lock the pure helper contracts that orchestration composes, so a regression
 * in hashing, config writing, spec resolution, or plugin loading fails here
 * first, fast, and without needing the `opencode` binary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildIsolatedOpenCodeEnv,
  checkPluginLoadProof,
  formatHashLine,
  hashFileOrAbsent,
  loadPluginFactory,
  packOutputFilename,
  specToPluginSpec,
  writeOpenCodeConfig,
} from "./helpers/integration-harness";
import { PLUGIN_LOAD_MARKER_CONTENT } from "../src/plugin-probe.js";

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

  test("drops hostile inherited OPENCODE_* vars and config-path overrides", () => {
    const parentEnv = {
      OPENCODE_CONFIG_CONTENT: '{"model":"evil"}',
      OPENCODE_CONFIG: "/evil/opencode.json",
      OPENCODE_PURE: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      HOME: "/evil/home",
    };

    const child = buildIsolatedOpenCodeEnv(seed, parentEnv);

    expect(child["OPENCODE_CONFIG_CONTENT"]).toBeUndefined();
    expect(child["OPENCODE_PURE"]).toBeUndefined();
    expect(child["HOME"]).toBe(seed.home);
    expect(child["OPENCODE_CONFIG"]).toBe(seed.configFile);
    expect(child["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
  });

  test("strips hostile XDG/HOME values and credential-like env entirely", () => {
    const parentEnv = {
      HOME: "/evil/home",
      XDG_CONFIG_HOME: "/evil/xdg",
      XDG_DATA_HOME: "/evil/data",
      XDG_CACHE_HOME: "/evil/cache",
      XDG_STATE_HOME: "/evil/state",
      OPENAI_API_KEY: "sk-evil-secret-value",
      ANTHROPIC_API_KEY: "sk-ant-evil",
      GITHUB_TOKEN: "ghp_evil",
    };

    const child = buildIsolatedOpenCodeEnv(seed, parentEnv);

    expect(child["HOME"]).toBe(seed.home);
    expect(child["XDG_CONFIG_HOME"]).toBe(seed.configDir);
    expect(child["XDG_DATA_HOME"]).toBe(seed.data);
    expect(child["XDG_CACHE_HOME"]).toBe(seed.cache);
    expect(child["XDG_STATE_HOME"]).toBe(seed.state);
    expect(child["OPENAI_API_KEY"]).toBeUndefined();
    expect(child["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(child["GITHUB_TOKEN"]).toBeUndefined();
  });

  test("forces all four isolation disable flags to 1", () => {
    const child = buildIsolatedOpenCodeEnv(seed, {
      OPENCODE_DISABLE_PROJECT_CONFIG: "0",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "0",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "0",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "0",
    });

    expect(child["OPENCODE_DISABLE_PROJECT_CONFIG"]).toBe("1");
    expect(child["OPENCODE_DISABLE_DEFAULT_PLUGINS"]).toBe("1");
    expect(child["OPENCODE_DISABLE_EXTERNAL_SKILLS"]).toBe("1");
    expect(child["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"]).toBe("1");
  });

  test("carries only a sanitized PATH plus optional locale/system vars", () => {
    const child = buildIsolatedOpenCodeEnv(seed, {
      PATH: "/usr/bin:/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      OTHER_LEGACY: "should-not-appear",
    });

    expect(child["PATH"]).toBe("/usr/bin:/bin");
    expect(child["TERM"]).toBe("xterm-256color");
    expect(child["LANG"]).toBe("en_US.UTF-8");
    expect(child["OTHER_LEGACY"]).toBeUndefined();
  });

  test("returns a fresh object that never aliases the parent env", () => {
    const parentEnv = { PATH: "/usr/bin:/bin" };

    const child = buildIsolatedOpenCodeEnv(seed, parentEnv);

    expect(child).not.toBe(parentEnv);
    parentEnv["PATH"] = "/mutated";
    expect(child["PATH"]).toBe("/usr/bin:/bin");
  });
});

describe("checkPluginLoadProof", () => {
  let proofRoot: string;
  const ENTRY = "file:///tmp/install/package/dist/plugin.js";
  const LISTED = `opencode version: 1.18.16\nplugins:\n- ${ENTRY}\n`;
  const MARKER = PLUGIN_LOAD_MARKER_CONTENT;

  beforeAll(async () => {
    proofRoot = await mkdtemp(join(tmpdir(), "antigravity-proof-"));
  });

  afterAll(async () => {
    await rm(proofRoot, { recursive: true, force: true });
  });

  test("passes only with exit 0, exact expected entry, marker, and no loader error", async () => {
    const markerPath = join(proofRoot, "proof-ok.marker");
    await writeFile(markerPath, MARKER);

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: LISTED,
      stderr: "unrelated noise",
      expectedEntry: ENTRY,
      markerPath,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("fails when a DIFFERENT plugin is listed even with exit 0 and no errors", async () => {
    const markerPath = join(proofRoot, "proof-unrelated.marker");
    await writeFile(markerPath, MARKER);
    const unrelatedList = "opencode version: 1.18.16\nplugins:\n- file:///other/plugin.js\n";

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: unrelatedList,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expected entry/);
  });

  test("fails when the expected entry is entirely missing from the plugins list", async () => {
    const markerPath = join(proofRoot, "proof-missing-entry.marker");
    await writeFile(markerPath, MARKER);

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: "opencode version: 1.18.16\nplugins:\n",
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expected entry/);
  });

  test("fails on nonzero exit even when entry is listed and marker exists", async () => {
    const markerPath = join(proofRoot, "proof-nonzero.marker");
    await writeFile(markerPath, MARKER);

    const result = await checkPluginLoadProof({
      exitCode: 3,
      stdout: LISTED,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exit/);
  });

  test("fails when the marker is absent even with entry listed, exit 0, and no errors", async () => {
    const markerPath = join(proofRoot, "proof-no-marker.marker");

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: LISTED,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/marker/);
  });

  test("fails when the marker content differs from the fixed contract", async () => {
    const markerPath = join(proofRoot, "proof-bad-content.marker");
    await writeFile(markerPath, "different content\n");

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: LISTED,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/marker/);
  });
});

describe("formatHashLine", () => {
  test("renders ABSENT distinctly from any present digest", () => {
    const line = formatHashLine("/tmp/config.jsonc", "ABSENT");
    expect(line).toContain("/tmp/config.jsonc");
    expect(line).toContain("ABSENT");
    expect(line).not.toMatch(/[0-9a-f]{64}/);
  });

  test("renders a present sha256 digest", () => {
    const digest = "a".repeat(64);
    const line = formatHashLine("/tmp/config.jsonc", digest);
    expect(line).toContain("/tmp/config.jsonc");
    expect(line).toContain(digest);
    expect(line).not.toContain("ABSENT");
  });
});
