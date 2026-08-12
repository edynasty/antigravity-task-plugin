/**
 * Isolated OpenCode loading harness (Todo 6) — replaces tests/integration-skip.ts.
 *
 * Runs with zero user/project config bleed: a freshly mkdtemp'd root owns the
 * HOME, OPENCODE_CONFIG, XDG data/cache/state dirs, the pack output, the
 * extracted install, and the plugin node_modules link. OpenCode child
 * processes get a strictly allowlisted environment (temp paths + isolation
 * flags + locale passthrough + the opt-in probe marker only) and run from a
 * neutral temp cwd, so inherited OPENCODE vars, XDG/HOME/credential values,
 * project config, default plugins, and external/Claude skills cannot bleed in.
 * It proves the strongest no-LLM OpenCode story available on 1.18.16:
 *
 *   1. the packed loader-safe entry (dist/plugin.js, single default factory)
 *      imports and instantiates with exactly one tool ("antigravity-task");
 *   2. `opencode debug config` resolves a config whose plugin spec points at
 *      the packed module (exit 0, spec present in the resolved JSON);
 *   3. a real load-bearing `opencode debug info --print-logs` run proves the
 *      packed factory EXECUTED under the real loader: exit 0, the exact
 *      expected entry in the parsed plugins list, the opt-in marker written
 *      by the factory body, and no "failed to load plugin" / "Plugin export
 *      is not a function" log (listing alone is NOT proof — the CLI prints
 *      configured URLs even when no load occurred);
 *   4. negative: an invalid plugin entry makes `opencode debug config` exit
 *      nonzero with an actionable schema error, and importing a definitely
 *      nonexistent plugin spec fails with an actionable load error;
 *   5. the live config files (~/.config/opencode/opencode.jsonc and
 *      ~/.omo/omo.jsonc) hash unchanged before/after, each present hash or
  *      ABSENT logged distinctly.
  *
  * Tool registration is proven by importing and instantiating the packed
  * module directly — the CLI cannot enumerate tools without a session/LLM
  * (documented limitation, no paid-model invocation).
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildIsolatedOpenCodeEnv,
  formatHashLine,
  generateProbeNonce,
  hashFileOrAbsent,
  loadPluginFactory,
  packOutputFilename,
  systemTmpDir,
  withoutProbeEnv,
  writeOpenCodeConfig,
} from "./helpers/integration-harness";
import { checkPluginLoadProof } from "./helpers/load-proof";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKED_ENTRY = join("package", "dist", "plugin.js");
const LIVE_CONFIG_FILES = [join(process.env["HOME"] ?? "/nonexistent", ".config", "opencode", "opencode.jsonc"), join(process.env["HOME"] ?? "/nonexistent", ".omo", "omo.jsonc")];

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawn a command. Build/pack/tooling passes the parent env (repo-local, no
 * isolation); OpenCode children pass the exact allowlist env built by
 * buildIsolatedOpenCodeEnv and are never merged with process.env.
 */
function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): SpawnResult {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
  return { exitCode: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

interface IsolatedEnv {
  readonly configFile: string;
  readonly processEnv: NodeJS.ProcessEnv;
  readonly workDir: string;
  readonly probeMarkerPath: string;
  readonly probeNonce: string;
}

async function makeIsolatedEnv(tempRoot: string): Promise<IsolatedEnv> {
  const home = join(tempRoot, "home");
  const data = join(tempRoot, "data");
  const cache = join(tempRoot, "cache");
  const state = join(tempRoot, "state");
  const configDir = join(home, ".config");
  const configFile = join(tempRoot, "opencode.json");
  const workDir = join(tempRoot, "work");
  const probeMarkerPath = join(tempRoot, "load-probe.marker");
  const probeNonce = generateProbeNonce();
  const tmpDirOverride = systemTmpDir();
  await Promise.all([home, data, cache, state, workDir, join(configDir, "opencode")].map((dir) => mkdir(dir, { recursive: true })));
  const seed = { home, configDir, configFile, data, cache, state, workDir, probeRootPath: tempRoot, probeMarkerPath, probeNonce, tmpDirOverride };
  return { configFile, workDir, probeMarkerPath, probeNonce, processEnv: buildIsolatedOpenCodeEnv(seed, process.env) };
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

async function logHashReceipts(label: string): Promise<readonly string[]> {
  const hashes = await Promise.all(LIVE_CONFIG_FILES.map((file) => hashFileOrAbsent(file)));
  hashes.forEach((hash, index) => {
    if (hash !== undefined) {
      console.log(`[INFO] ${label} ${formatHashLine(LIVE_CONFIG_FILES[index] ?? "?", hash)}`);
    }
  });
  return hashes;
}

function parseDebugConfig(stdout: string): { plugin?: readonly unknown[] } {
  return JSON.parse(stdout) as { plugin?: readonly unknown[] };
}

async function main(): Promise<number> {
  const failures: string[] = [];
  const pass = (name: string, detail = ""): void => console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ""}`);
  const fail = (name: string, detail: string): void => {
    failures.push(`${name}: ${detail}`);
    console.error(`[FAIL] ${name} — ${detail}`);
  };

  const tempRoot = await mkdtemp(join(systemTmpDir(), "antigravity-task-plugin-int-"));
  let opencodeBin: string;
  try {
    const env = await makeIsolatedEnv(tempRoot);
    const packDir = join(tempRoot, "pack");
    const installDir = join(tempRoot, "install");
    await mkdir(packDir, { recursive: true });

    // Live-config hash guard: capture before any OpenCode invocation. Absence
    // is a valid state (ABSENT marker); only a change before/after is a failure.
    const hashesBefore = await logHashReceipts("live-config-before");

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

    // 3. Import + instantiate the PACKED loader-safe entry: exact tool registration.
    //    The dedicated entry exports only the default factory (loader-safe);
    //    root named/default compatibility is covered by tests/plugin.test.ts.
    //    The probe env vars (if hostile in the parent) are cleared for this
    //    direct-import check — the probe only belongs in the isolated child.
    const loaded = await withoutProbeEnv(() => loadPluginFactory(entryUrl));
    if (loaded.defaultIsFunction && loaded.toolKeys.length === 1 && loaded.toolKeys[0] === "antigravity-task") {
      pass("packed-tool-registration", `exactly ["antigravity-task"] via packed default factory`);
    } else {
      fail("packed-tool-registration", JSON.stringify(loaded));
    }

    // 3b. Pack metadata: the dedicated entry and its declaration are in the artifact.
    const packedEntry = join(installDir, "package", "dist", "plugin.js");
    if ((await Bun.file(packedEntry).exists()) && (await Bun.file(join(installDir, "package", "dist", "plugin.d.ts")).exists())) {
      pass("packed-entry-present", `dist/plugin.js + dist/plugin.d.ts in tarball`);
    } else {
      fail("packed-entry-present", `missing packed plugin entry ${packedEntry}`);
    }

    // 4. Config pointing at the packed module resolves under `opencode debug config`
    //    from the neutral temp cwd with the strictly isolated allowlist env.
    //    Freshness first: assert no stale marker exists, then clear stale
    //    marker/tmp inside the verified root before ANY probe-var command so a
    //    precreated file cannot replay a previous proof.
    if (existsSync(env.probeMarkerPath)) {
      fail("probe-freshness", `marker pre-exists (replay risk): ${env.probeMarkerPath}`);
    }
    rmSync(`${env.probeMarkerPath}.tmp`, { force: true });
    await writeOpenCodeConfig(dirname(env.configFile), [entryUrl]);
    const cfg = run(opencodeBin, ["debug", "config"], env.workDir, env.processEnv);
    const resolvedPlugin = cfg.exitCode === 0 ? parseDebugConfig(cfg.stdout).plugin ?? [] : [];
    if (cfg.exitCode !== 0) {
      fail("debug-config-resolve", `exit ${cfg.exitCode}: ${cfg.stderr.trim()}`);
    } else if (resolvedPlugin.includes(entryUrl)) {
      pass("debug-config-resolve", `resolved plugin spec present (exit 0)`);
    } else {
      fail("debug-config-resolve", `plugin spec missing from resolved config: ${JSON.stringify(resolvedPlugin)}`);
    }
    // The debug-config run may have loaded the plugin and written the marker;
    // clear it (harness owns the verified root) so check 5 proves a FRESH write.
    rmSync(env.probeMarkerPath, { force: true });
    rmSync(`${env.probeMarkerPath}.tmp`, { force: true });

    // 5. Real load-bearing proof: `debug info` invokes the packed factory under
    //    the legacy loader. Listing alone is NOT proof (the CLI prints configured
    //    URLs even when no load occurred); checkPluginLoadProof gates on exit 0 +
    //    exact entry + nonce-bound marker content + no loader errors.
    const info = run(opencodeBin, ["--print-logs", "--log-level", "DEBUG", "debug", "info"], env.workDir, env.processEnv);
    const proof = await checkPluginLoadProof({
      exitCode: info.exitCode,
      stdout: info.stdout,
      stderr: info.stderr,
      expectedEntry: entryUrl,
      markerPath: env.probeMarkerPath,
      expectedNonce: env.probeNonce,
    });
    if (!proof.ok) {
      fail("plugin-load-proof", proof.reason ?? "unknown load failure");
    } else {
      pass("plugin-load-proof", `factory executed under real loader: exit 0, entry listed, nonce-bound marker written, no errors`);
    }

    // 6. Startup resolves in the isolated env.
    const startup = run(opencodeBin, ["debug", "startup"], env.workDir, env.processEnv);
    if (startup.exitCode === 0 && startup.stdout.trim().length > 0) {
      pass("debug-startup", `exit 0, timing printed`);
    } else {
      fail("debug-startup", `exit ${startup.exitCode}, stdout=${JSON.stringify(startup.stdout.trim())}, stderr=${startup.stderr.trim()}`);
    }

    // 7. NEGATIVE A: invalid plugin entry shape is rejected by `debug config` itself.
    await writeOpenCodeConfig(dirname(env.configFile), [42]);
    const negA = run(opencodeBin, ["debug", "config"], env.workDir, env.processEnv);
    if (negA.exitCode !== 0 && /Expected string \| array|plugin/i.test(negA.stderr)) {
      pass("negative-invalid-entry", `exit ${negA.exitCode}, actionable schema error`);
    } else {
      fail("negative-invalid-entry", `expected nonzero + schema error, got exit ${negA.exitCode}: ${negA.stderr.trim()}`);
    }

    // 8. NEGATIVE B: importing a definitely nonexistent plugin spec fails load.
    const missingSpec = pathToFileURL(join(tempRoot, "definitely-missing-plugin.ts")).href;
    try {
      await withoutProbeEnv(() => loadPluginFactory(missingSpec));
      fail("negative-missing-plugin", `import of ${missingSpec} unexpectedly succeeded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Cannot find module|no such file/i.test(message)) {
        pass("negative-missing-plugin", `load failed with actionable module-not-found`);
      } else {
        fail("negative-missing-plugin", `unexpected failure mode: ${message.slice(0, 200)}`);
      }
    }

    // 9. Live-config hash guard: nothing touched after all success/failure runs.
    const hashesAfter = await logHashReceipts("live-config-after");
    if (hashesBefore.every((hash, index) => hash === hashesAfter[index])) {
      pass("live-config-unchanged", `before/after identical (present hashes or ABSENT)`);
    } else {
      fail("live-config-unchanged", `changed: ${LIVE_CONFIG_FILES.filter((_, index) => hashesBefore[index] !== hashesAfter[index]).join(", ")}`);
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
