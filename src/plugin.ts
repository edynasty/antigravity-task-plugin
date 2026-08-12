/**
 * Dedicated OpenCode plugin entry (Todo 6 blocker + security remediation).
 *
 * OpenCode 1.18.16's legacy plugin loader (packages/opencode/src/plugin/
 * index.ts, getLegacyPlugins) iterates Object.values(module) and treats EVERY
 * export as a plugin candidate: each value must be a function (or an object
 * with a `.server` function), otherwise it throws "Plugin export is not a
 * function" and the whole plugin fails to load (CLI still exits 0).
 *
 * The root src/index.ts deliberately exports PACKAGE_IDENTITY, the schema
 * object and the arg normalizer alongside the plugin factories — none of
 * which are loader-safe. This entry exposes ONLY the single callable plugin
 * factory as the default export, so Object.values() contains exactly one
 * function and no duplicate registration can occur.
 *
 * It also carries a narrow, opt-in load probe for the integration harness:
 * when ANTIGRAVITY_TASK_PLUGIN_ROOT, ANTIGRAVITY_TASK_PLUGIN_MARKER and
 * ANTIGRAVITY_TASK_PLUGIN_NONCE (see plugin-probe.ts) are all set to a
 * verified system-temp integration root, its exact direct-child marker path
 * and this invocation's nonce, the factory writes a nonce-bound marker
 * atomically BEFORE delegating to the real plugin. This proves the packed
 * factory actually executed under OpenCode's loader — `debug info` lists
 * configured plugin URLs even when no load occurred, so a listed entry is not
 * proof, and the nonce binding makes a precreated marker unable to replay a
 * stale proof. The root is validated (non-symlink directory under canonical
 * tmpdir() with the exact harness mkdtemp basename, marker = exact direct
 * child) and NO filesystem write ever happens outside it; an invalid contract
 * fails the plugin load with a bounded error. Without the env vars, zero
 * probe I/O happens and runtime behavior is byte-for-byte the real plugin.
 * The entry module itself still exports ONLY the factory function.
 */
import { AntigravityTaskPlugin } from "./index.js";
import { PLUGIN_LOAD_MARKER_ENV, PLUGIN_LOAD_NONCE_ENV, PLUGIN_LOAD_ROOT_ENV, writeLoadMarker } from "./plugin-probe.js";

export default async function antigravityTaskPluginProbe(
  input: Parameters<typeof AntigravityTaskPlugin>[0],
  options?: Parameters<typeof AntigravityTaskPlugin>[1],
) {
  writeLoadMarker(process.env[PLUGIN_LOAD_ROOT_ENV], process.env[PLUGIN_LOAD_MARKER_ENV], process.env[PLUGIN_LOAD_NONCE_ENV]);
  return AntigravityTaskPlugin(input, options);
}
