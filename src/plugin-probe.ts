/**
 * Shared constants and validation for the opt-in OpenCode load probe
 * (Todo 6 proof + security + freshness remediation).
 *
 * Kept OUT of src/plugin.ts so the dedicated plugin entry module exports ONLY
 * the callable plugin factory: OpenCode 1.18.16's legacy loader iterates
 * Object.values(module) and throws "Plugin export is not a function" for any
 * non-function export.
 *
 * Security contract: the probe must NEVER write outside a verified system-temp
 * integration root. All three env vars are required and must match — the root
 * must be a real (non-symlink) directory under canonical tmpdir() whose
 * basename matches the exact mkdtemp shape (harness prefix + six-character
 * suffix), the marker must be its exact direct-child basename, and the marker
 * content is bound to a per-run nonce so a precreated marker cannot replay a
 * stale proof. Any mismatch is rejected with a bounded error and zero
 * filesystem writes. All three vars absent = zero probe I/O.
 */
import { existsSync, lstatSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export const PLUGIN_LOAD_MARKER_ENV = "ANTIGRAVITY_TASK_PLUGIN_MARKER";
export const PLUGIN_LOAD_ROOT_ENV = "ANTIGRAVITY_TASK_PLUGIN_ROOT";
export const PLUGIN_LOAD_NONCE_ENV = "ANTIGRAVITY_TASK_PLUGIN_NONCE";
export const PLUGIN_LOAD_ROOT_PREFIX = "antigravity-task-plugin-int-";
export const PLUGIN_LOAD_MARKER_BASENAME = "load-probe.marker";

/** Exact mkdtemp basename shape: harness prefix + six alphanumeric characters. */
const ROOT_BASENAME_PATTERN = /^antigravity-task-plugin-int-[A-Za-z0-9]{6}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Nonce-bound marker content: fixed prefix + this invocation's nonce. */
export function probeMarkerContent(nonce: string): string {
  return `antigravity-task-plugin-factory-executed:${nonce}\n`;
}

function canonicalTmpDir(): string {
  return realpathSync(tmpdir());
}

/** The verified integration root: canonical, exact mkdtemp basename, direct tmpdir child. */
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
  if (!ROOT_BASENAME_PATTERN.test(basename(canonical))) {
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
 * undefined when valid (including when ALL vars are absent — zero I/O).
 */
export function validateProbeContract(
  rootEnv: string | undefined,
  markerEnv: string | undefined,
  nonceEnv: string | undefined,
): string | undefined {
  if (rootEnv === undefined && markerEnv === undefined && nonceEnv === undefined) {
    return undefined;
  }
  if (rootEnv === undefined || markerEnv === undefined || nonceEnv === undefined) {
    return "probe requires all three of ANTIGRAVITY_TASK_PLUGIN_ROOT, ANTIGRAVITY_TASK_PLUGIN_MARKER and ANTIGRAVITY_TASK_PLUGIN_NONCE together";
  }
  if (!NONCE_PATTERN.test(nonceEnv)) {
    return "probe nonce must be 32 lowercase hex characters";
  }
  if (verifiedMarker(rootEnv, markerEnv) === undefined) {
    return "probe root must be a non-symlink directory with prefix antigravity-task-plugin-int-<6 chars> under the temp dir, marker its exact direct-child load-probe.marker";
  }
  return undefined;
}

/**
 * Write the nonce-bound marker inside a verified root. The marker parent is
 * the canonical root (never mkdir'd here — the root already exists as a real
 * directory). The temp file is created exclusively (wx) so a precreated file
 * fails the load instead of allowing a stale-proof replay; rename happens
 * only within the verified canonical root. Throws a bounded error on contract
 * violations so the plugin load fails loudly instead of writing elsewhere.
 */
export function writeLoadMarker(
  rootEnv: string | undefined,
  markerEnv: string | undefined,
  nonceEnv: string | undefined,
): void {
  if (rootEnv === undefined && markerEnv === undefined && nonceEnv === undefined) {
    return;
  }
  const error = validateProbeContract(rootEnv, markerEnv, nonceEnv);
  if (error !== undefined) {
    throw new Error(`antigravity-task plugin load probe rejected: ${error}`);
  }
  const root = verifiedRoot(rootEnv);
  if (root === undefined) {
    throw new Error("antigravity-task plugin load probe rejected: unverified root");
  }
  const marker = join(root, PLUGIN_LOAD_MARKER_BASENAME);
  if (existsSync(marker)) {
    throw new Error("antigravity-task plugin load probe rejected: marker already exists");
  }
  const temp = `${marker}.tmp`;
  const content = probeMarkerContent(nonceEnv ?? "");
  try {
    writeFileSync(temp, content, { flag: "wx" });
  } catch {
    throw new Error("antigravity-task plugin load probe rejected: marker temp already exists");
  }
  renameSync(temp, marker);
}
