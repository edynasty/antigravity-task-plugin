/**
 * Shared constants for the opt-in OpenCode load probe (Todo 6 proof blocker).
 *
 * Kept OUT of src/plugin.ts so the dedicated plugin entry module exports ONLY
 * the callable plugin factory: OpenCode 1.18.16's legacy loader iterates
 * Object.values(module) and throws "Plugin export is not a function" for any
 * non-function export, so a string constant on the entry would break loading.
 * Both the entry (to write) and the harness checker (to verify) import the
 * same fixed, non-secret contract from here — one source of truth, no drift.
 */
export const PLUGIN_LOAD_MARKER_ENV = "ANTIGRAVITY_TASK_PLUGIN_MARKER";
export const PLUGIN_LOAD_MARKER_CONTENT = "antigravity-task-plugin-factory-executed\n";
