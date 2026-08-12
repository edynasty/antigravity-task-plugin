/**
 * Dedicated OpenCode plugin entry (Todo 6 blocker remediation).
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
 * when ANTIGRAVITY_TASK_PLUGIN_MARKER (see plugin-probe.ts) is set — a path
 * the harness generates inside its isolated temp root — the factory writes a
 * fixed, non-secret marker atomically BEFORE delegating to the real plugin.
 * This proves the packed factory actually executed under OpenCode's loader —
 * `debug info` lists configured plugin URLs even when no load occurred, so a
 * listed entry is not proof. Without the env var, zero probe I/O happens and
 * runtime behavior is byte-for-byte the real plugin. The entry module itself
 * still exports ONLY the factory function (loader-safe).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AntigravityTaskPlugin } from "./index.js";
import { PLUGIN_LOAD_MARKER_CONTENT, PLUGIN_LOAD_MARKER_ENV } from "./plugin-probe.js";

function writeLoadMarker(markerPath: string): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  const temp = `${markerPath}.tmp`;
  writeFileSync(temp, PLUGIN_LOAD_MARKER_CONTENT, "utf8");
  renameSync(temp, markerPath);
}

export default async function antigravityTaskPluginProbe(
  input: Parameters<typeof AntigravityTaskPlugin>[0],
  options?: Parameters<typeof AntigravityTaskPlugin>[1],
) {
  const markerPath = process.env[PLUGIN_LOAD_MARKER_ENV];
  if (markerPath !== undefined && markerPath.length > 0) {
    writeLoadMarker(markerPath);
  }
  return AntigravityTaskPlugin(input, options);
}
