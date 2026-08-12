import { afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const SRC_INDEX_PATH = join(REPO_ROOT, "src", "index.ts");
export const FIXTURE_PATH = join(REPO_ROOT, "tests", "fixtures", "fake-agy.ts");
export const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");

const tempDirs: string[] = [];

export async function makeTempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "antigravity-task-plugin-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

export type FakeRunResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export async function runFake(scenario: string, cwd: string): Promise<FakeRunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, FIXTURE_PATH],
    cwd,
    env: { ...process.env, AGY_FAKE_SCENARIO: scenario },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await withTimeout(proc.exited, 10_000, `fake-agy scenario ${scenario} did not exit within 10s`);
  return { stdout, stderr, exitCode };
}

export type PackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly scripts: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
};

export function readPackageManifest(): PackageManifest {
  const parsed: PackageManifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  return parsed;
}

export interface NDJsonEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export function parseStream(stdout: string): readonly NDJsonEvent[] {
  const events: NDJsonEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`fake-agy emitted a non-JSON line: ${trimmed.slice(0, 120)}`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new Error("fake-agy emitted a non-object JSON line");
    }
    const eventName = parsed["event"];
    if (typeof eventName !== "string") {
      throw new Error("fake-agy event line is missing a string 'event' field");
    }
    events.push({ event: eventName, ...parsed });
  }
  return events;
}

export type Usage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly thinking_tokens: number;
  readonly cache_read_tokens: number;
  readonly total_tokens: number;
};

export type ResultPayload = {
  readonly conversation_id: string;
  readonly status: string;
  readonly response: string;
  readonly error?: string;
  readonly usage: Usage;
};

export function isResultPayload(value: unknown): value is ResultPayload {
  if (!isRecord(value)) {
    return false;
  }
  const usage = value["usage"];
  if (!isRecord(usage)) {
    return false;
  }
  return (
    typeof value["conversation_id"] === "string" &&
    typeof value["status"] === "string" &&
    typeof value["response"] === "string" &&
    (value["error"] === undefined || typeof value["error"] === "string") &&
    typeof usage["input_tokens"] === "number" &&
    typeof usage["output_tokens"] === "number" &&
    typeof usage["thinking_tokens"] === "number" &&
    typeof usage["cache_read_tokens"] === "number" &&
    typeof usage["total_tokens"] === "number"
  );
}

export function requireResult(payload: unknown): ResultPayload {
  if (isResultPayload(payload)) {
    return payload;
  }
  throw new Error("fake-agy result event does not match the official result envelope shape");
}
