/**
 * Shared constants and validation for the opt-in OpenCode load probe
 * (Todo 6 proof + security remediation).
 *
 * Kept OUT of src/plugin.ts so the dedicated plugin entry module exports ONLY
 * the callable plugin factory: OpenCode 1.18.16's legacy loader iterates
 * Object.values(module) and throws "Plugin export is not a function" for any
 * non-function export. Both the entry (to write) and the harness checker (to
 * verify) import the same fixed, non-secret contract from here.
 *
 * Security contract: the probe must NEVER write outside a verified system-temp
 * integration root. BOTH env vars are required and must match — the root must
 * be a real (non-symlink) directory under canonical tmpdir() with the harness
 * prefix, and the marker must be its exact direct-child basename. Any mismatch
 * is rejected with a bounded error and zero filesystem writes.
 */
import { lstatSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const PLUGIN_LOAD_MARKER_ENV = "ANTIGRAVITY_TASK_PLUGIN_MARKER";
export const PLUGIN_LOAD_ROOT_ENV = "ANTIGRAVITY_TASK_PLUGIN_ROOT";
export const PLUGIN_LOAD_ROOT_PREFIX = "antigravity-task-plugin-int-";
export const PLUGIN_LOAD_MARKER_BASENAME = "load-probe.marker";
export const PLUGIN_LOAD_MARKER_CONTENT = "antigravity-task-plugin-factory-executed\n";

function canonicalTmpDir(): string {
  return realpathSync(tmpdir());
}

/** The verified integration root: canonical, harness-prefixed, direct tmpdir child. */
function verifiedRoot(rootEnv: string | undefined): string | undefined {
  if (rootEnv === undefined || rootEnv.length === 0) {
    return undefined;
  }
  let stat;
  try {
    stat = lstatSync(rootEnv);
  } catch {
    return undefined;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return undefined;
  }
  const canonical = realpathSync(rootEnv);
  if (dirname(canonical) !== canonicalTmpDir()) {
    return undefined;
  }
  if (!basename(canonical).startsWith(PLUGIN_LOAD_ROOT_PREFIX)) {
    return undefined;
  }
  return canonical;
}

/**
 * Canonical form of the marker env value: the marker's parent must be the
 * canonical root (macOS /var -> /private/var realpath), the marker must be
 * the exact direct-child basename, and the path must not traverse outside
 * the root. Returns undefined when invalid.
 */
function verifiedMarker(rootEnv: string | undefined, markerEnv: string | undefined): string | undefined {
  if (rootEnv === undefined || markerEnv === undefined || markerEnv.length === 0) {
    return undefined;
  }
  const root = verifiedRoot(rootEnv);
  if (root === undefined) {
    return undefined;
  }
  const markerParent = dirname(markerEnv);
  let parentReal: string;
  try {
    parentReal = realpathSync(markerParent);
  } catch {
    return undefined;
  }
  if (parentReal !== root) {
    return undefined;
  }
  if (basename(markerEnv) !== PLUGIN_LOAD_MARKER_BASENAME) {
    return undefined;
  }
  return join(root, PLUGIN_LOAD_MARKER_BASENAME);
}

/**
 * Validate the probe contract. Returns a bounded error message when invalid,
 * undefined when valid (including when BOTH vars are absent — zero I/O).
 */
export function validateProbeContract(rootEnv: string | undefined, markerEnv: string | undefined): string | undefined {
  if (rootEnv === undefined && markerEnv === undefined) {
    return undefined;
  }
  if (rootEnv === undefined || markerEnv === undefined) {
    return "probe requires both ANTIGRAVITY_TASK_PLUGIN_ROOT and ANTIGRAVITY_TASK_PLUGIN_MARKER";
  }
  if (verifiedMarker(rootEnv, markerEnv) === undefined) {
    return "probe root must be a non-symlink directory under the system temp dir with prefix antigravity-task-plugin-int- and marker its exact direct-child load-probe.marker";
  }
  return undefined;
}

/**
 * Write the fixed marker inside a verified root. Callers must validate first;
 * the marker parent is the canonical root (never mkdir'd here — the root
 * already exists as a real directory). Throws a bounded error on contract
 * violations so the plugin load fails loudly instead of writing elsewhere.
 */
export function writeLoadMarker(rootEnv: string | undefined, markerEnv: string | undefined): void {
  if (rootEnv === undefined && markerEnv === undefined) {
    return;
  }
  const error = validateProbeContract(rootEnv, markerEnv);
  if (error !== undefined) {
    throw new Error(`antigravity-task plugin load probe rejected: ${error}`);
  }
  const marker = verifiedMarker(rootEnv, markerEnv);
  if (marker === undefined) {
    throw new Error("antigravity-task plugin load probe rejected: unverified marker path");
  }
  const temp = `${marker}.tmp`;
  try {
    rmSync(temp, { force: true });
  } catch {
    // stale temp cleanup is best-effort; the write below still proceeds
  }
  writeFileSync(temp, PLUGIN_LOAD_MARKER_CONTENT, "utf8");
  renameSync(temp, marker);
}
