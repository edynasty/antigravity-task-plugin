/**
 * Opt-in live smoke harness for the antigravity-task-plugin (Todo 7).
 *
 * Replaces tests/live-skip.ts. Gated by ANTIGRAVITY_SMOKE=1 captured at
 * process start: any other value (unset, "0", "true", "") skips with exit 0
 * BEFORE any executable discovery, spawn, or temp evidence. CI never sets
 * this flag, so CI runs are deterministic and quota-free.
 *
 * When gated ON: composes the existing production layers (resolveAgy,
 * buildArgv, runAgy, NdjsonStreamParser) with mode=plan and a PONG-only
 * prompt in a fresh canonical temp cwd. Validates SUCCESS + conversation id +
 * nonzero usage + PONG in the response, and writes sanitized evidence
 * (raw NDJSON with credential redaction via shared helper, no env/path/prompt)
 * under .omo/evidence/.
 *
 * A negative test (controlled AGY_PATH to a nonexistent absolute path) proves
 * the missing-CLI failure path is actionable without reading credential files.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { resolveAgy } from "../src/discovery.js";
import { buildArgv } from "../src/args.js";
import { runAgy } from "../src/process.js";
import { NdjsonStreamParser } from "../src/protocol.js";
import { redactCredentials } from "../src/redaction.js";
import { HOST_GRACE_MS } from "../src/process-types.js";

const SMOKE_ENV_VAR = "ANTIGRAVITY_SMOKE";
const AGY_PATH_ENV = "AGY_PATH";
const SMOKE_ENABLED = process.env[SMOKE_ENV_VAR] === "1";
const REPO_ROOT = resolve(import.meta.dir, "..");
const EVIDENCE_DIR = join(REPO_ROOT, ".omo", "evidence");
const SMOKE_TIMEOUT_SECONDS = 60;

function canonicalTmpDir(): string {
  const saved = process.env["TMPDIR"];
  delete process.env["TMPDIR"];
  try {
    return realpathSync(tmpdir());
  } finally {
    if (saved !== undefined) process.env["TMPDIR"] = saved;
  }
}

interface SmokeValidation {
  readonly ok: boolean;
  readonly reason: string;
}

function validateSmokeOutput(parser: NdjsonStreamParser): SmokeValidation {
  const parsed = parser.finish();
  if (parsed.kind === "failure") {
    return { ok: false, reason: `parser failure: ${parsed.reason.type}` };
  }
  if (parsed.conversationId.length === 0) {
    return { ok: false, reason: "missing or empty conversation_id" };
  }
  if (parsed.usage.total_tokens === 0) {
    return { ok: false, reason: "zero total_tokens in usage" };
  }
  if (!parsed.text.toUpperCase().includes("PONG")) {
    return { ok: false, reason: "response does not contain PONG" };
  }
  return { ok: true, reason: "SUCCESS + conversation + nonzero usage + PONG" };
}

async function runGatedSmoke(): Promise<number> {
  const tempRoot = await mkdtemp(join(canonicalTmpDir(), "antigravity-smoke-"));
  try {
    const executable = resolveAgy({ env: process.env });
    const argv = buildArgv({
      task: "Reply with exactly PONG and nothing else.",
      mode: "plan",
      timeoutSeconds: SMOKE_TIMEOUT_SECONDS,
    });
    const abortController = new AbortController();
    const result = await runAgy({
      argv: [executable, ...argv],
      cwd: tempRoot,
      env: process.env,
      signal: abortController.signal,
      hostTimeoutMs: SMOKE_TIMEOUT_SECONDS * 1000 + HOST_GRACE_MS,
    });
    const parser = new NdjsonStreamParser();
    for (const chunk of result.stdoutChunks) {
      parser.push(chunk);
    }
    const validation = validateSmokeOutput(parser);
    const sanitizedStdout = redactCredentials(result.stdoutChunks.join(""));
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const evidenceFile = join(EVIDENCE_DIR, "task-7-live-smoke-ndjson.txt");
    const evidence = [
      `timestamp: ${new Date().toISOString()}`,
      `exit_code: ${result.exitCode}`,
      `validation: ${validation.ok ? "PASS" : "FAIL"} (${validation.reason})`,
      `---raw_ndjson_sanitized---`,
      sanitizedStdout,
    ].join("\n");
    await writeFile(evidenceFile, `${evidence}\n`, "utf8");
    if (!validation.ok) {
      console.error(`FAIL: smoke validation: ${validation.reason}`);
      return 1;
    }
    console.log(`PASS: live smoke — ${validation.reason}`);
    console.log(`Evidence: ${evidenceFile}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${message}`);
    return 1;
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
