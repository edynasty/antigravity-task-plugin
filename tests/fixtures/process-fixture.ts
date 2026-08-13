/**
 * Process-only fixture for Todo 4 lifecycle tests (argv/cwd recording, exit
 * codes, stderr/stdout emission, hangs and SIGTERM-ignoring processes).
 * Select a scenario with AGY_PROC_SCENARIO; unknown scenarios fail loudly on
 * stderr with exit code 2. Signal handlers and the PID file write happen
 * BEFORE the first observable output so a parent that reacts to output can
 * never signal a child whose handlers are not yet wired.
 *
 * Scenario contract:
 *   record      -> writes {argv, cwd, envProbe} JSON to AGY_RECORD_PATH, exit 0
 *   stderr      -> writes AGY_STDERR_LINES diagnostics to stderr, exit AGY_EXIT_CODE
 *   output      -> writes AGY_STDOUT_LINES lines to stdout, exit 0
 *   hang        -> writes one line then waits; SIGTERM -> 143, SIGINT -> 130
 *   ignore-term -> writes one line then waits; SIGTERM is ignored (SIGKILL only)
 *   signal-term -> kills itself with SIGTERM so the parent sees code null + signal
 *   pipe-hold   -> spawns a descendant that holds stdout/stderr open, records both
 *                  PIDs, then exits 0; the descendant (sh -> sleep) outlives it
 *   ndjson-stream -> writes AGY_NDJSON_STREAM (JSON string array) to stdout, one
 *                  line per AGY_NDJSON_DELAY_MS (default 30), then exits 0
 * Every scenario writes its own PID to AGY_PID_PATH first.
 */
import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import process from "node:process";
import {
  CHILD_PID_PATH_ENV,
  ENV_PROBE_ENV,
  EXIT_CODE_ENV,
  NDJSON_DELAY_ENV,
  NDJSON_STREAM_ENV,
  PID_PATH_ENV,
  PROC_SCENARIO_ENV,
  RECORD_PATH_ENV,
  STDERR_LINES_ENV,
  STDOUT_LINES_ENV,
} from "./process-env";

const SCENARIO_VALUES = ["record", "stderr", "output", "hang", "ignore-term", "signal-term", "pipe-hold", "ndjson-stream"] as const;
type Scenario = (typeof SCENARIO_VALUES)[number];

const SCENARIO_SET: ReadonlySet<string> = new Set<string>(SCENARIO_VALUES);

function isScenario(value: string): value is Scenario {
  return SCENARIO_SET.has(value);
}

function writePidFile(): void {
  const pidPath = process.env[PID_PATH_ENV];
  if (pidPath !== undefined) {
    writeFileSync(pidPath, `${process.pid}\n`);
  }
}

function writeLines(fd: number, count: number, prefix: string): void {
  for (let index = 1; index <= count; index += 1) {
    writeSync(fd, `${prefix} ${index}\n`);
  }
}

function runRecord(): void {
  writePidFile();
  const recordPath = process.env[RECORD_PATH_ENV];
  if (recordPath !== undefined) {
    writeFileSync(
      recordPath,
      JSON.stringify({ argv: process.argv.slice(1), cwd: process.cwd(), envProbe: process.env[ENV_PROBE_ENV] ?? null }),
    );
  }
  process.exit(0);
}

function runStderr(): void {
  writePidFile();
  writeLines(2, Number(process.env[STDERR_LINES_ENV] ?? "1"), "process-fixture diagnostic");
  process.exit(Number(process.env[EXIT_CODE_ENV] ?? "1"));
}

function runOutput(): void {
  writePidFile();
  writeLines(1, Number(process.env[STDOUT_LINES_ENV] ?? "3"), "process-fixture stdout line");
  process.exit(0);
}

function runHang(): void {
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  writePidFile();
  setInterval(() => undefined, 60_000);
  writeSync(1, "process-fixture hanging\n");
}

function runIgnoreTerm(): void {
  process.on("SIGTERM", () => undefined);
  writePidFile();
  setInterval(() => undefined, 60_000);
  writeSync(1, "process-fixture ignoring SIGTERM\n");
}

function runSignalTerm(): void {
  writePidFile();
  process.kill(process.pid, "SIGTERM");
}

function runPipeHold(): void {
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
  writePidFile();
  const childPidPath = process.env[CHILD_PID_PATH_ENV];
  if (childPidPath !== undefined) {
    const descendant = spawn(
      "/bin/sh",
      ["-c", `echo $$ > ${JSON.stringify(childPidPath)}; exec sleep 60`],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    descendant.unref();
  }
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Writes a JSON string array of NDJSON lines (AGY_NDJSON_STREAM) to stdout,
 * one per AGY_NDJSON_DELAY_MS (default 30), then exits 0. Each writeSync is a
 * synchronous syscall, so the parent observes each chunk before close — this
 * proves the progress observer fires mid-execution, not after completion.
 */
/**
 * Writes a JSON string array of NDJSON lines (AGY_NDJSON_STREAM) to stdout,
 * one per AGY_NDJSON_DELAY_MS (default 30), then exits 0. writeSync is a
 * synchronous syscall, so the parent observes each chunk before close.
 */
async function runNdjsonStream(): Promise<void> {
  writePidFile();
  const raw = process.env[NDJSON_STREAM_ENV] ?? "[]";
  const delay = Math.max(0, Number(process.env[NDJSON_DELAY_ENV] ?? "30"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    writeSync(2, "process-fixture: AGY_NDJSON_STREAM must be a JSON string array\n");
    process.exit(2);
  }
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) {
    writeSync(2, "process-fixture: AGY_NDJSON_STREAM must be a JSON string array\n");
    process.exit(2);
  }
  for (const ndjsonLine of parsed) {
    writeSync(1, `${ndjsonLine}\n`);
    await sleep(delay);
  }
  process.exit(0);
}

function main(): void {
  const raw = process.env[PROC_SCENARIO_ENV] ?? "record";
  if (!isScenario(raw)) {
    writeSync(2, `process-fixture: unknown scenario ${JSON.stringify(raw)}\n`);
    process.exit(2);
  }
  switch (raw) {
    case "record":
      runRecord();
      break;
    case "stderr":
      runStderr();
      break;
    case "output":
      runOutput();
      break;
    case "hang":
      runHang();
      break;
    case "ignore-term":
      runIgnoreTerm();
      break;
    case "signal-term":
      runSignalTerm();
      break;
    case "pipe-hold":
      runPipeHold();
      break;
    case "ndjson-stream":
      void runNdjsonStream();
      break;
  }
}

main();
