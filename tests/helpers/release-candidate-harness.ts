/**
 * Release-candidate harness (Todo 8).
 *
 * Builds + packs the repository into a generated temp root, extracts the
 * tarball into a fresh temp project (no global install), links the
 * @opencode-ai peer dep exactly as an OpenCode install would satisfy it, and
 * imports/instantiates the PACKED loader-safe entry (dist/plugin.js),
 * asserting exactly one tool under the exact id "antigravity-task".
 *
 * Also provides self-contained fake-agy executable wrappers that record the
 * direct child PID, the exact spawn argv and the spawn cwd to side files, so
 * the packed plugin's real spawn contract can be asserted without any real
 * agy, network, credential, or live-config access. `disposePacked` removes
 * the whole temp root; every failure path cleans up before rethrowing.
 */
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./fake-agy-harness";
import { packOutputFilename } from "./integration-harness";
import { mockToolContext } from "./runner-harness";
import type { AntigravityTaskArgs, ToolPayload } from "../../src/runner-types";
import type { ToolContext } from "@opencode-ai/plugin";

export interface PackedPlugin {
  readonly tempRoot: string;
  readonly projectDir: string;
  readonly entryUrl: string;
  readonly tool: {
    readonly execute: (args: AntigravityTaskArgs, context: ToolContext) => Promise<ToolPayload>;
  };
}

export interface FakeAgy {
  readonly executable: string;
  readonly pidFile: string;
  readonly argvFile: string;
  readonly cwdFile: string;
}

function runSync(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (exit ${String(result.status)}): ${(result.stderr ?? "").trim().slice(0, 300)}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * Fresh release candidate: rebuild, npm pack into a generated temp dir,
 * extract the tarball into a fresh temp project, link the peer dep, then
 * import and instantiate the packed loader-safe entry. Any failure removes
 * the whole temp root before rethrowing.
 */
export async function preparePackedPlugin(): Promise<PackedPlugin> {
  const tempRoot = await mkdtemp(join(tmpdir(), "antigravity-release-"));
  const packDir = join(tempRoot, "pack");
  const installDir = join(tempRoot, "install");
  const projectPath = join(tempRoot, "project");
  try {
    await mkdir(packDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    const projectDir = await realpath(projectPath);

    runSync("bun", ["run", "build"], REPO_ROOT);
    const packOutput = runSync("npm", ["pack", "--pack-destination", packDir], REPO_ROOT);
    const tarball = join(packDir, packOutputFilename(packOutput));

    await mkdir(installDir, { recursive: true });
    runSync("tar", ["-xzf", tarball, "-C", installDir], REPO_ROOT);
    const peerParent = join(installDir, "package", "node_modules");
    await mkdir(peerParent, { recursive: true });
    await symlink(join(REPO_ROOT, "node_modules", "@opencode-ai"), join(peerParent, "@opencode-ai"), "dir");

    const entryUrl = pathToFileURL(join(installDir, "package", "dist", "plugin.js")).href;
    const mod = (await import(entryUrl)) as { readonly default?: unknown };
    if (typeof mod.default !== "function") {
      throw new Error(`packed entry ${entryUrl} exposes no default factory`);
    }
    const hooks = await (mod.default as () => Promise<{ readonly tool?: Readonly<Record<string, unknown>> }>)();
    const toolKeys = Object.keys(hooks.tool ?? {});
    if (toolKeys.length !== 1 || toolKeys[0] !== "antigravity-task") {
      throw new Error(`packed plugin registered ${JSON.stringify(toolKeys)}; expected exactly ["antigravity-task"]`);
    }
    const tool = (hooks.tool ?? {})["antigravity-task"] as PackedPlugin["tool"];
    return { tempRoot, projectDir, entryUrl, tool };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Remove the whole release-candidate temp root. */
export function disposePacked(plugin: PackedPlugin): Promise<void> {
  return rm(plugin.tempRoot, { recursive: true, force: true });
}

const FIXTURE_PATH = join(REPO_ROOT, "tests", "fixtures", "fake-agy.ts");

/**
 * Self-contained fake-agy executable: records the direct child PID, the exact
 * spawn argv and the spawn cwd to side files, then execs the deterministic
 * fake fixture with the requested scenario. exec preserves the PID, so the
 * PID file is the exact direct child and proves runAgy's cleanup after
 * timeout/abort.
 */
export async function makeFakeAgy(plugin: PackedPlugin, scenario: string, tag: string): Promise<FakeAgy> {
  const executable = join(plugin.tempRoot, `fake-agy-${tag}`);
  const pidFile = join(plugin.tempRoot, `${tag}.pid`);
  const argvFile = join(plugin.tempRoot, `${tag}.argv`);
  const cwdFile = join(plugin.tempRoot, `${tag}.cwd`);
  const script = [
    "#!/bin/sh",
    `echo $$ > '${pidFile}'`,
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `pwd > '${cwdFile}'`,
    `export AGY_FAKE_SCENARIO='${scenario}'`,
    `exec '${process.execPath}' '${FIXTURE_PATH}' "$@"`,
    "",
  ].join("\n");
  await writeFile(executable, script, { mode: 0o755 });
  chmodSync(executable, 0o755);
  return { executable, pidFile, argvFile, cwdFile };
}

/** Read the direct-child PID recorded by a fake-agy wrapper. */
export async function readPid(pidFile: string): Promise<number> {
  const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid recorded PID in ${pidFile}`);
  }
  return pid;
}

/** Poll until kill(pid, 0) fails (ESRCH) or the deadline passes. */
export async function waitPidGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return !pidAlive(pid);
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Run `body` with AGY_PATH pointing at the fake executable (save/restore). */
export async function withAgyPath<T>(fake: FakeAgy, body: () => Promise<T>): Promise<T> {
  const previous = process.env["AGY_PATH"];
  process.env["AGY_PATH"] = fake.executable;
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env["AGY_PATH"];
    } else {
      process.env["AGY_PATH"] = previous;
    }
  }
}

/** Bound a tool call so a broken teardown cannot hang the suite. */
export function withToolTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} exceeded ${ms}ms`)), ms);
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

/** Tool context bound to the packed plugin's fresh temp project cwd. */
export function packedContext(plugin: PackedPlugin, signal: AbortSignal): ToolContext {
  return mockToolContext(plugin.projectDir, signal);
}
