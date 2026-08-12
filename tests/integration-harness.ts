/**
 * Isolated OpenCode loading harness (Todo 6) — replaces tests/integration-skip.ts.
 *
 * Runs with zero user/project config bleed: a freshly mkdtemp'd root owns the
 * HOME, OPENCODE_CONFIG, XDG data/cache/state dirs, the pack output, the
 * extracted install, and the plugin node_modules link. It proves the strongest
 * no-LLM OpenCode story available on 1.18.16:
 *
 *   1. the packed artifact imports and instantiates with exactly one tool
 *      ("antigravity-task"), via default and named factory exports;
 *   2. `opencode debug config` resolves a config whose plugin spec points at
 *      the packed module (exit 0, spec present in the resolved JSON);
 *   3. `opencode debug startup` exits 0 in the isolated env;
 *   4. negative: an invalid plugin entry makes `opencode debug config` exit
 *      nonzero with an actionable schema error, and importing a definitely
 *      nonexistent plugin spec fails with an actionable load error;
 *   5. the live config files (~/.config/opencode/opencode.jsonc and
 *      ~/.omo/omo.jsonc) are byte-identical before and after every run.
 *
 * OpenCode CLI cannot enumerate a plugin's tools without a session/LLM, so
 * tool registration is proven by importing and instantiating the packed
 * module directly — documented limitation, not a paid-model invocation.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ABSENT, hashFileOrAbsent, loadPluginFactory, packOutputFilename, writeOpenCodeConfig } from "./helpers/integration-harness";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKED_ENTRY = join("package", "dist", "index.js");
const LIVE_CONFIG_FILES = [join(process.env["HOME"] ?? "/nonexistent", ".config", "opencode", "opencode.jsonc"), join(process.env["HOME"] ?? "/nonexistent", ".omo", "omo.jsonc")];

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): SpawnResult {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

interface IsolatedEnv {
  readonly configFile: string;
  readonly processEnv: NodeJS.ProcessEnv;
}

async function makeIsolatedEnv(tempRoot: string): Promise<IsolatedEnv> {
  const home = join(tempRoot, "home");
  const data = join(tempRoot, "data");
  const cache = join(tempRoot, "cache");
  const state = join(tempRoot, "state");
  const configFile = join(tempRoot, "opencode.json");
  await mkdir(home, { recursive: true });
  await mkdir(data, { recursive: true });
  await mkdir(cache, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  return {
    configFile,
    processEnv: {
      HOME: home,
      OPENCODE_CONFIG: configFile,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
    },
  };
}

async function extractTarball(tarball: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const result = run("tar", ["-xzf", tarball, "-C", destDir], REPO_ROOT);
  if (result.exitCode !== 0) {
    throw new Error(`tar extraction failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
}

/** Symlink the repo's @opencode-ai install into the packed tree so the peer dep resolves. */
async function linkPeerDep(installDir: string): Promise<void> {
  const linkTarget = join(installDir, "package", "node_modules", "@opencode-ai");
  await mkdir(dirname(linkTarget), { recursive: true });
  await symlink(join(REPO_ROOT, "node_modules", "@opencode-ai"), linkTarget, "dir");
}

async function hashLiveConfigs(): Promise<readonly string[]> {
  return Promise.all(LIVE_CONFIG_FILES.map((file) => hashFileOrAbsent(file)));
}

function parseDebugConfig(stdout: string): { plugin?: readonly unknown[] } {
  const parsed = JSON.parse(stdout) as { plugin?: readonly unknown[] };
  return parsed;
}

async function main(): Promise<number> {
  const failures: string[] = [];
  const pass = (name: string, detail = ""): void => console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ""}`);
  const fail = (name: string, detail: string): void => {
    failures.push(`${name}: ${detail}`);
    console.error(`[FAIL] ${name} — ${detail}`);
  };

  const tempRoot = await mkdtemp(join(tmpdir(), "antigravity-task-plugin-int-"));
  let opencodeBin: string;
  try {
    const env = await makeIsolatedEnv(tempRoot);
    const packDir = join(tempRoot, "pack");
    const installDir = join(tempRoot, "install");
    await mkdir(packDir, { recursive: true });

    // Live-config hash guard: capture before any OpenCode invocation.
    const hashesBefore = await hashLiveConfigs();
    if (hashesBefore.includes(ABSENT)) {
      const names = LIVE_CONFIG_FILES.map((file) => (hashesBefore[LIVE_CONFIG_FILES.indexOf(file)] === ABSENT ? file : "")).filter(Boolean);
      fail("live-config-presence", `expected both live config files present, absent: ${names.join(", ")}`);
    }

    // 0. Locate the opencode binary (CI installs opencode-ai@1.18.16 globally).
    const which = run("which", ["opencode"], REPO_ROOT);
    if (which.exitCode !== 0) {
      throw new Error(`opencode CLI not found on PATH; install with: npm i -g opencode-ai@1.18.16 (${which.stderr.trim()})`);
    }
    opencodeBin = which.stdout.trim();

    // 1. Build + pack the repository into the temp pack dir.
    const build = run("bun", ["run", "build"], REPO_ROOT);
    if (build.exitCode !== 0) {
      throw new Error(`bun run build failed (exit ${build.exitCode}): ${build.stderr.trim()}`);
    }
    const pack = run("npm", ["pack", "--pack-destination", packDir], REPO_ROOT);
    if (pack.exitCode !== 0) {
      throw new Error(`npm pack failed (exit ${pack.exitCode}): ${pack.stderr.trim()}`);
    }
    const tarballName = packOutputFilename(pack.stdout);
    const tarball = join(packDir, tarballName);
    pass("build-and-pack", `${tarballName}`);

    // 2. Extract the packed artifact and make its peer dep resolvable.
    await extractTarball(tarball, installDir);
    await linkPeerDep(installDir);
    const entryUrl = pathToFileURL(join(installDir, PACKED_ENTRY)).href;
    pass("extract-and-link", entryUrl);

    // 3. Import + instantiate the PACKED module: exact tool registration.
    const loaded = await loadPluginFactory(entryUrl);
    if (loaded.defaultIsFunction && loaded.namedIsFunction && loaded.toolKeys.length === 1 && loaded.toolKeys[0] === "antigravity-task") {
      pass("packed-tool-registration", `exactly ["antigravity-task"] via default+named factory`);
    } else {
      fail("packed-tool-registration", JSON.stringify(loaded));
    }

    // 4. Config pointing at the packed module resolves under `opencode debug config`.
    await writeOpenCodeConfig(dirname(env.configFile), [entryUrl]);
    const cfg = run(opencodeBin, ["debug", "config"], REPO_ROOT, env.processEnv);
    if (cfg.exitCode !== 0) {
      fail("debug-config-resolve", `exit ${cfg.exitCode}: ${cfg.stderr.trim()}`);
    } else {
      const plugin = parseDebugConfig(cfg.stdout).plugin ?? [];
      if (plugin.includes(entryUrl)) {
        pass("debug-config-resolve", `resolved plugin spec present (exit 0)`);
      } else {
        fail("debug-config-resolve", `plugin spec missing from resolved config: ${JSON.stringify(plugin)}`);
      }
    }

    // 5. Startup resolves in the isolated env.
    const startup = run(opencodeBin, ["debug", "startup"], REPO_ROOT, env.processEnv);
    if (startup.exitCode === 0 && startup.stdout.trim().length > 0) {
      pass("debug-startup", `exit 0, timing printed`);
    } else {
      fail("debug-startup", `exit ${startup.exitCode}, stdout=${JSON.stringify(startup.stdout.trim())}, stderr=${startup.stderr.trim()}`);
    }

    // 6. NEGATIVE A: invalid plugin entry shape is rejected by `debug config` itself.
    await writeOpenCodeConfig(dirname(env.configFile), [42]);
    const negA = run(opencodeBin, ["debug", "config"], REPO_ROOT, env.processEnv);
    if (negA.exitCode !== 0 && /Expected string \| array|plugin/i.test(negA.stderr)) {
      pass("negative-invalid-entry", `exit ${negA.exitCode}, actionable schema error`);
    } else {
      fail("negative-invalid-entry", `expected nonzero + schema error, got exit ${negA.exitCode}: ${negA.stderr.trim()}`);
    }

    // 7. NEGATIVE B: importing a definitely nonexistent plugin spec fails load.
    const missingSpec = pathToFileURL(join(tempRoot, "definitely-missing-plugin.ts")).href;
    try {
      await loadPluginFactory(missingSpec);
      fail("negative-missing-plugin", `import of ${missingSpec} unexpectedly succeeded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Cannot find module|no such file/i.test(message)) {
        pass("negative-missing-plugin", `load failed with actionable module-not-found`);
      } else {
        fail("negative-missing-plugin", `unexpected failure mode: ${message.slice(0, 200)}`);
      }
    }

    // 8. Live-config hash guard: nothing touched after all success/failure runs.
    const hashesAfter = await hashLiveConfigs();
    const unchanged = hashesBefore.every((hash, index) => hash === hashesAfter[index]);
    if (unchanged) {
      pass("live-config-unchanged", `both files byte-identical before/after`);
    } else {
      const diffs = LIVE_CONFIG_FILES.map((file, index) => (hashesBefore[index] === hashesAfter[index] ? "" : file)).filter(Boolean);
      fail("live-config-unchanged", `changed: ${diffs.join(", ")}`);
    }
  } catch (error) {
    fail("harness-setup", error instanceof Error ? error.message : String(error));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED:`);
    for (const item of failures) {
      console.error(`  - ${item}`);
    }
    return 1;
  }
  console.log(`\nALL INTEGRATION CHECKS PASS`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("harness crashed:", error);
    process.exit(2);
  });
