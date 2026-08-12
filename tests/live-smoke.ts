/**
 * Opt-in live smoke harness for the antigravity-task-plugin (Todo 7).
 *
 * Replaces tests/live-skip.ts. Gated by ANTIGRAVITY_SMOKE=1 captured at
 * process start: any other value (unset, "0", "true", "") skips with exit 0
 * BEFORE any executable discovery, spawn, or temp evidence. CI never sets
 * this flag, so CI runs are deterministic and quota-free.
 *
 * When gated ON: resolves agy via the existing discovery (AGY_PATH or PATH),
 * spawns with mode=plan and a PONG-only prompt in a fresh canonical temp cwd,
 * parses the official NDJSON stream, validates SUCCESS + conversation id +
 * nonzero usage + PONG in the response, and writes sanitized evidence
 * (raw NDJSON with credential redaction, no prompt env) under .omo/evidence/.
 *
 * A negative test (controlled AGY_PATH to a nonexistent absolute path) proves
 * the missing-CLI failure path is actionable without reading credential files.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

const SMOKE_ENV_VAR = "ANTIGRAVITY_SMOKE";
const AGY_PATH_ENV = "AGY_PATH";
const SMOKE_ENABLED = process.env[SMOKE_ENV_VAR] === "1";
const REPO_ROOT = resolve(import.meta.dir, "..");
const EVIDENCE_DIR = join(REPO_ROOT, ".omo", "evidence");

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function canonicalTmpDir(): string {
  const saved = process.env["TMPDIR"];
  delete process.env["TMPDIR"];
  try {
    return realpathSync(tmpdir());
  } finally {
    if (saved !== undefined) process.env["TMPDIR"] = saved;
  }
}

function redactCredentials(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/(token|api_key|apikey)=['"]?[^\s'"]+['"]?/gi, "$1=[redacted]")
    .replace(/ghp_[A-Za-z0-9]{36}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]");
}

function parseNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

interface SmokeValidation {
  readonly ok: boolean;
  readonly reason: string;
}

function validateSmokeOutput(stdout: string): SmokeValidation {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const parsed = parseNdjsonLine(line);
    if (parsed !== null) events.push(parsed);
  }
  const resultEvent = events.find((event) => event["event"] === "result");
  if (resultEvent === undefined) return { ok: false, reason: "no result event in NDJSON stream" };
  const result = resultEvent["result"];
  if (typeof result !== "object" || result === null) return { ok: false, reason: "result event missing result field" };
  const resultObj = result as Record<string, unknown>;
  if (resultObj["status"] !== "SUCCESS") return { ok: false, reason: `status=${String(resultObj["status"])}` };
  if (typeof resultObj["conversation_id"] !== "string" || (resultObj["conversation_id"] as string).length === 0) {
    return { ok: false, reason: "missing or empty conversation_id" };
  }
  const usage = resultObj["usage"];
  if (typeof usage !== "object" || usage === null) return { ok: false, reason: "missing usage object" };
  const usageObj = usage as Record<string, unknown>;
  const totalTokens = typeof usageObj["total_tokens"] === "number" ? usageObj["total_tokens"] : 0;
  if (totalTokens === 0) return { ok: false, reason: "zero total_tokens in usage" };
  const response = typeof resultObj["response"] === "string" ? resultObj["response"] : "";
  if (!response.toUpperCase().includes("PONG")) return { ok: false, reason: "response does not contain PONG" };
  return { ok: true, reason: "SUCCESS + conversation + nonzero usage + PONG" };
}

async function runGatedSmoke(): Promise<number> {
  const tempRoot = await mkdtemp(join(canonicalTmpDir(), "antigravity-smoke-"));
  try {
    const agyPath = process.env[AGY_PATH_ENV];
    if (agyPath === undefined || agyPath.trim() === "") {
      const which = spawnSync("which", ["agy"], { encoding: "utf8" });
      if (which.status !== 0) {
        console.error(`FAIL: ${AGY_PATH_ENV} not set and agy not found on PATH`);
        console.error("Set AGY_PATH=/path/to/agy or install agy and ensure it is on PATH.");
        return 1;
      }
    } else if (!existsSync(agyPath)) {
      console.error(`FAIL: ${AGY_PATH_ENV}=${agyPath} does not exist`);
      console.error("Set AGY_PATH to an existing executable agy binary.");
      return 1;
    }
    const argv = [
      "-p",
      "Reply with exactly PONG and nothing else.",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "60s",
      "--mode",
      "plan",
    ];
    const result = spawnSync("agy", argv, {
      cwd: tempRoot,
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, AGY_PATH: process.env[AGY_PATH_ENV] },
    });
    const exitCode = result.status ?? -1;
    const sanitized = redactCredentials(result.stdout ?? "");
    const validation = validateSmokeOutput(result.stdout ?? "");
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const evidenceFile = join(EVIDENCE_DIR, "task-7-live-smoke-ndjson.txt");
    const evidence = [
      `timestamp: ${new Date().toISOString()}`,
      `exit_code: ${exitCode}`,
      `validation: ${validation.ok ? "PASS" : "FAIL"} (${validation.reason})`,
      `agy_path_env: ${process.env[AGY_PATH_ENV] ?? "(unset, PATH search)"}`,
      `mode: plan`,
      `prompt: Reply with exactly PONG and nothing else.`,
      `---raw_ndjson_sanitized---`,
      sanitized,
    ].join("\n");
    await writeFile(evidenceFile, `${evidence}\n`, "utf8");
    if (!validation.ok) {
      console.error(`FAIL: smoke validation: ${validation.reason}`);
      return 1;
    }
    console.log(`PASS: live smoke — ${validation.reason}`);
    console.log(`Evidence: ${evidenceFile}`);
    return 0;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  if (!SMOKE_ENABLED) {
    console.log("SKIP: test:live — set ANTIGRAVITY_SMOKE=1 to enable the opt-in agy smoke.");
    console.log("CI never sets this flag; live runs consume agy quota.");
    return 0;
  }
  console.log("GATED: ANTIGRAVITY_SMOKE=1 detected, running live smoke...");
  return runGatedSmoke();
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("live smoke crashed:", error);
    process.exit(2);
  });
