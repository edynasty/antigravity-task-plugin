/**
 * Pure helpers for the isolated OpenCode loading harness (Todo 6).
 *
 * Each function is deterministic and side-effect scoped to paths passed in —
 * no home-directory, config, or cache access beyond the caller-supplied args.
 * The E2E orchestration in tests/integration-harness.ts composes these, and
 * tests/integration-harness.test.ts locks the contracts.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_LOAD_MARKER_ENV, PLUGIN_LOAD_NONCE_ENV, PLUGIN_LOAD_ROOT_ENV } from "../../src/plugin-probe.js";

/** Marker for a config file that does not exist (distinct from any digest). */
export const ABSENT = "ABSENT";

/** Locale/system vars a CLI child may need; carried verbatim when present. */
const PASSTHROUGH_VARS = ["PATH", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const;

/** Explicit allowlist isolation flags for OpenCode child processes. */
const ISOLATION_FLAGS = [
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
] as const;

export interface OpenCodeEnvSeed {
  readonly home: string;
  readonly configDir: string;
  readonly configFile: string;
  readonly data: string;
  readonly cache: string;
  readonly state: string;
  readonly workDir: string;
  readonly probeRootPath?: string;
  readonly probeMarkerPath?: string;
  readonly probeNonce?: string;
  readonly tmpDirOverride?: string;
}

/**
 * Build the strictly isolated environment for an OpenCode child process.
 * Returns a fresh object containing ONLY the seed paths, the four isolation
 * flags forced to "1", passthrough locale/system vars from the parent, and —
 * when the harness opts in — the probe root/marker/nonce env vars. The probe
 * vars are NEVER inherited from the parent: all three come from the generated
 * seed. TMPDIR comes ONLY from the seed override (applied last, after any
 * passthrough) so a hostile parent value can never win. Never OPENCODE_PURE,
 * never OPENCODE_CONFIG_CONTENT, never credential-like or inherited
 * config-path values.
 */
export function buildIsolatedOpenCodeEnv(seed: OpenCodeEnvSeed, parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    HOME: seed.home,
    OPENCODE_CONFIG: seed.configFile,
    XDG_CONFIG_HOME: seed.configDir,
    XDG_DATA_HOME: seed.data,
    XDG_CACHE_HOME: seed.cache,
    XDG_STATE_HOME: seed.state,
  };
  for (const flag of ISOLATION_FLAGS) {
    child[flag] = "1";
  }
  for (const key of PASSTHROUGH_VARS) {
    const value = parentEnv[key];
    if (value !== undefined) {
      child[key] = value;
    }
  }
  if (seed.tmpDirOverride !== undefined) {
    child["TMPDIR"] = seed.tmpDirOverride;
  }
  if (seed.probeRootPath !== undefined && seed.probeMarkerPath !== undefined && seed.probeNonce !== undefined) {
    child[PLUGIN_LOAD_ROOT_ENV] = seed.probeRootPath;
    child[PLUGIN_LOAD_MARKER_ENV] = seed.probeMarkerPath;
    child[PLUGIN_LOAD_NONCE_ENV] = seed.probeNonce;
  }
  return child;
}

/** Generate a fresh per-run proof nonce: 32 lowercase hex characters. */
export function generateProbeNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Canonical system temp dir, independent of any inherited/hostile TMPDIR. */
export function systemTmpDir(): string {
  const inherited = process.env["TMPDIR"];
  delete process.env["TMPDIR"];
  try {
    return realpathSync(tmpdir());
  } finally {
    setOrDelete("TMPDIR", inherited);
  }
}

/**
 * Run `body` with the probe env vars cleared (save/restore). The probe root,
 * marker and nonce belong ONLY in the isolated child env; hostile parent
 * values must never affect a direct in-process import/instantiation.
 */
export async function withoutProbeEnv<T>(body: () => Promise<T>): Promise<T> {
  const previousRoot = process.env[PLUGIN_LOAD_ROOT_ENV];
  const previousMarker = process.env[PLUGIN_LOAD_MARKER_ENV];
  const previousNonce = process.env[PLUGIN_LOAD_NONCE_ENV];
  delete process.env[PLUGIN_LOAD_ROOT_ENV];
  delete process.env[PLUGIN_LOAD_MARKER_ENV];
  delete process.env[PLUGIN_LOAD_NONCE_ENV];
  try {
    return await body();
  } finally {
    setOrDelete(PLUGIN_LOAD_ROOT_ENV, previousRoot);
    setOrDelete(PLUGIN_LOAD_MARKER_ENV, previousMarker);
    setOrDelete(PLUGIN_LOAD_NONCE_ENV, previousNonce);
  }
}

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** Render a config-file hash receipt: path + 64-hex digest, or ABSENT. */
export function formatHashLine(file: string, hash: string): string {
  return `${file} ${hash}`;
}

/** sha256 hex digest of the file at `path`, or "ABSENT" when it does not exist. */

export interface LoadedPlugin {
  readonly defaultIsFunction: boolean;
  readonly namedIsFunction: boolean;
  readonly toolKeys: readonly string[];
}

/** sha256 hex digest of the file at `path`, or "ABSENT" when it does not exist. */
export async function hashFileOrAbsent(path: string): Promise<string> {
  try {
    await stat(path);
  } catch {
    return ABSENT;
  }
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Write a config declaring $schema plus the given plugin specs; returns the file path.
 * The plugin array genuinely accepts `string | [string, object]` entries per the
 * OpenCode config schema, so entries are typed as `unknown` and written verbatim.
 */
export async function writeOpenCodeConfig(configDir: string, pluginSpecs: readonly unknown[]): Promise<string> {
  await mkdir(configDir, { recursive: true });
  const file = join(configDir, "opencode.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: pluginSpecs,
  };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Normalize a plugin config spec the way OpenCode resolves it for `debug config`:
 * relative/absolute filesystem paths become file URLs; bare package names and
 * file URLs pass through unchanged.
 */
export function specToPluginSpec(spec: string, baseDir?: string): string {
  if (spec.startsWith("file://") || /^[a-z][a-z0-9+.-]*:/i.test(spec)) {
    return spec;
  }
  if (isAbsolute(spec)) {
    return pathToFileURL(spec).href;
  }
  if (baseDir !== undefined) {
    return pathToFileURL(resolve(baseDir, spec)).href;
  }
  return spec;
}

/** Extract the tarball filename from `npm pack` stdout (last *.tgz token). */
export function packOutputFilename(output: string): string {
  const matches = output.trim().split(/\s+/).filter((token) => token.endsWith(".tgz"));
  const last = matches[matches.length - 1];
  if (last === undefined) {
    throw new Error("npm pack produced no .tgz filename");
  }
  return last;
}

interface PluginModule {
  readonly default?: unknown;
  readonly AntigravityTaskPlugin?: unknown;
}

/**
 * Import a plugin entry module and instantiate its factory, returning whether
 * default/named exports are callable and the exact registered tool keys.
 */
export async function loadPluginFactory(entryUrl: string): Promise<LoadedPlugin> {
  const mod = (await import(entryUrl)) as PluginModule;
  const factory = mod.default ?? mod.AntigravityTaskPlugin;
  if (typeof factory !== "function") {
    throw new Error(`plugin module ${entryUrl} exposes no default or AntigravityTaskPlugin factory`);
  }
  const hooks = (await factory()) as { tool?: Record<string, unknown> };
  return {
    defaultIsFunction: typeof mod.default === "function",
    namedIsFunction: typeof mod.AntigravityTaskPlugin === "function",
    toolKeys: Object.keys(hooks.tool ?? {}),
  };
}
