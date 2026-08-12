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
 * which are loader-safe. This entry re-exports ONLY the single callable
 * plugin factory as the default export, so Object.values() contains exactly
 * one function and no duplicate registration can occur.
 */
import { AntigravityTaskPlugin } from "./index.js";

export default AntigravityTaskPlugin;
