/**
 * Tests for the opt-in live smoke harness (Todo 7).
 *
 * Locks the skip path (ANTIGRAVITY_SMOKE != "1" exits 0 with skip message)
 * and the missing-AGY_PATH negative (nonexistent absolute path exits 1 with
 * actionable error, no credential scan). The real gated success path is NOT
 * tested here because it consumes agy quota; it is proven manually via
 * `ANTIGRAVITY_SMOKE=1 bun run test:live` with a valid agy installation.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SMOKE_SCRIPT = "tests/live-smoke.ts";

describe("live smoke skip path", () => {
  test("exits 0 with skip message when ANTIGRAVITY_SMOKE is unset", () => {
    const result = spawnSync("bun", [SMOKE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ANTIGRAVITY_SMOKE: undefined },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP");
    expect(result.stdout).toContain("ANTIGRAVITY_SMOKE=1");
  });

  test("exits 0 with skip message when ANTIGRAVITY_SMOKE is '0'", () => {
    const result = spawnSync("bun", [SMOKE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ANTIGRAVITY_SMOKE: "0" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP");
  });

  test("exits 0 with skip message when ANTIGRAVITY_SMOKE is 'true'", () => {
    const result = spawnSync("bun", [SMOKE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ANTIGRAVITY_SMOKE: "true" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP");
  });
});

describe("live smoke missing-path negative", () => {
  test("exits 1 with actionable error when AGY_PATH points to nonexistent binary", () => {
    const result = spawnSync("bun", [SMOKE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ANTIGRAVITY_SMOKE: "1",
        AGY_PATH: "/definitely/nonexistent/agy-binary-path",
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toMatch(/AGY_PATH.*does not exist/);
    expect(combined).not.toMatch(/sk-|Bearer|api_key|token=/i);
  });
});
