/**
 * Strict load-proof checker for the isolated OpenCode loading harness (Todo 6).
 *
 * `opencode debug info` prints configured plugin URLs even when no load
 * occurred and exits 0, so a listed entry or a clean exit is NOT proof. The
 * checker requires all five gates: exitCode 0, the exact expected entry in
 * the parsed plugins list, the marker file carrying THIS invocation's nonce
 * (a precreated fixed marker cannot replay a stale proof), and no
 * legacy-loader error in the logs. Kept in its own helper module so the
 * harness and the load-proof tests share one implementation while every file
 * stays <= 250 pure LOC.
 */
import { readFile } from "node:fs/promises";
import { probeMarkerContent } from "../../src/plugin-probe.js";

/** OpenCode legacy-loader failure signals that must never appear in load logs. */
const PLUGIN_LOAD_ERROR_PATTERN = /failed to load plugin|Plugin export is not a function/i;

export interface PluginLoadProofInput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly expectedEntry: string;
  readonly markerPath: string;
  readonly expectedNonce: string;
}

export interface PluginLoadProofResult {
  readonly ok: boolean;
  readonly reason: string | undefined;
}

/** Parse the `plugins:` section of `opencode debug info` output into exact entries. */
export function parseDebugPluginList(stdout: string): readonly string[] {
  const lines = stdout.split("\n");
  const headerIndex = lines.findIndex((line) => line.startsWith("plugins:"));
  if (headerIndex === -1) {
    return [];
  }
  const entries: string[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      entries.push(trimmed.slice(2).trim());
    }
  }
  return entries;
}

/**
 * Verify the nonce-bound marker proves the packed factory executed under
 * OpenCode's real loader. A precreated fixed-content marker fails the nonce
 * gate, so a stale proof cannot be replayed.
 */
export async function checkPluginLoadProof(input: PluginLoadProofInput): Promise<PluginLoadProofResult> {
  if (input.exitCode !== 0) {
    return { ok: false, reason: `debug info exited ${input.exitCode}` };
  }
  const listed = parseDebugPluginList(input.stdout);
  if (!listed.includes(input.expectedEntry)) {
    return { ok: false, reason: `expected entry not listed: ${input.expectedEntry}; got ${JSON.stringify(listed)}` };
  }
  const loadLog = `${input.stderr}\n${input.stdout}`;
  const loadError = loadLog.match(PLUGIN_LOAD_ERROR_PATTERN)?.[0];
  if (loadError !== undefined) {
    return { ok: false, reason: `legacy loader reported: ${loadError}` };
  }
  let marker: string;
  try {
    marker = await readFile(input.markerPath, "utf8");
  } catch {
    return { ok: false, reason: `marker absent: ${input.markerPath}` };
  }
  if (marker !== probeMarkerContent(input.expectedNonce)) {
    return { ok: false, reason: `marker content mismatch at ${input.markerPath} (nonce-bound)` };
  }
  return { ok: true, reason: undefined };
}
