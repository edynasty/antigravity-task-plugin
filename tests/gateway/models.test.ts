/**
 * Gateway model listing (Todo 13): `agy models` is executed as a local
 * subprocess (never a network call); output is parsed one-line-per-model and
 * cached with a TTL, falling back to the cache file and then builtins.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessError } from "../../src/process-types";
import { BUILTIN_MODELS, listModels, parseModelsOutput } from "../../src/gateway/models";
import { makeGatewayDeps } from "./gateway-harness";

const tempDirs: string[] = [];

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agy-gateway-models-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCache(cacheDir: string, models: readonly string[], fetchedAt: number): void {
  writeFileSync(join(cacheDir, "models.json"), JSON.stringify({ models, fetchedAt }));
}

describe("parseModelsOutput", () => {
  test("one model per line; first whitespace token is the id", () => {
    expect(parseModelsOutput("gemini-3.7-flash-high\nclaude-sonnet-4-6\n")).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
  });

  test("tabs, trailing spaces and CRLF are tolerated", () => {
    expect(parseModelsOutput("gemini-3.7-flash-high\t(active)\r\nclaude-sonnet-4-6  \r\n")).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
  });

  test("blank lines are skipped", () => {
    expect(parseModelsOutput("\n\n  \nfirst\n\nsecond\n\n")).toEqual(["first", "second"]);
  });

  test("empty output parses to no models", () => {
    expect(parseModelsOutput("")).toEqual([]);
  });
});

describe("listModels cache and fallback", () => {
  test("a fresh cache is served without spawning agy", async () => {
    const fake = makeGatewayDeps();
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, ["cached-model"], Date.now());

    const models = await listModels(fake.deps, { ttlSeconds: 3600, cacheDir });
    expect(models).toEqual(["cached-model"]);
    expect(fake.runCalls.length).toBe(0);
  });

  test("a stale cache triggers `agy models`; the result rewrites the cache", async () => {
    const fake = makeGatewayDeps();
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, ["stale-model"], Date.now() - 4_000_000);

    fake.setStdout("gemini-3.7-flash-high\nclaude-sonnet-4-6\n");

    const models = await listModels(fake.deps, { ttlSeconds: 3600, cacheDir });
    expect(models).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
    expect(fake.runCalls.length).toBe(1);
    expect(fake.runCalls[0]?.argv[fake.runCalls[0]!.argv.length - 1]).toBe("models");
    const cached = JSON.parse(readFileSync(join(cacheDir, "models.json"), "utf8")) as { models: readonly string[]; fetchedAt: number };
    expect(cached.models).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
    expect(cached.fetchedAt).toBeGreaterThan(0);
  });

  test("a run failure falls back to the stale cache file", async () => {
    const fake = makeGatewayDeps();
    const cacheDir = tempCacheDir();
    writeCache(cacheDir, ["stale-model"], Date.now() - 4_000_000);
    fake.failRun(new ProcessError("spawn-failed", "failed to spawn agy: ENOENT"));

    const models = await listModels(fake.deps, { ttlSeconds: 3600, cacheDir });
    expect(models).toEqual(["stale-model"]);
    expect(fake.runCalls.length).toBe(1);
  });

  test("a run failure with no cache file falls back to builtins", async () => {
    const fake = makeGatewayDeps();
    const cacheDir = tempCacheDir();
    fake.failRun(new ProcessError("spawn-failed", "failed to spawn agy: ENOENT"));

    const models = await listModels(fake.deps, { ttlSeconds: 3600, cacheDir });
    expect(models).toEqual(BUILTIN_MODELS);
  });

  test("the cache directory is created on demand", async () => {
    const fake = makeGatewayDeps();
    const cacheDir = tempCacheDir();
    rmSync(cacheDir, { recursive: true, force: true });
    fake.setStdout("fresh-model\n");

    await listModels(fake.deps, { ttlSeconds: 3600, cacheDir });
    expect(existsSync(join(cacheDir, "models.json"))).toBe(true);
  });

  test("a nonexistent fresh cache triggers `agy models` once", async () => {
    const fake = makeGatewayDeps();
    const cacheDir = tempCacheDir();
    fake.setStdout("gemini-3.7-flash-high\n");

    const first = await listModels(fake.deps, { ttlSeconds: 3600, cacheDir });
    expect(first).toEqual(["gemini-3.7-flash-high"]);

    const second = await listModels(fake.deps, { ttlSeconds: 3600, cacheDir });
    expect(second).toEqual(["gemini-3.7-flash-high"]);
    expect(fake.runCalls.length).toBe(1);
  });
});
