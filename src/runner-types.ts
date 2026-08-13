/**
 * Shared types, dependency seam and bounded helpers for the Todo 5 runner.
 * Pure module: no process, network, or filesystem access. `runAntigravityTask`
 * in runner.ts composes discovery/argv/process/parser; this module defines the
 * tool argument contract, the injectable adapter seam, and the typed
 * success/failure surface the OpenCode tool returns.
 */
import { redactCredentials } from "./redaction.js";
import type { Mode } from "./args.js";
import type { Diagnostic, ProgressSnapshot, Status, Usage } from "./protocol.js";
import type { DiscoveryOptions, ProcessResult, SpawnOptions } from "./process.js";
import type { ProcessExit } from "./process-types.js";

/** Tool argument contract. The OpenCode schema (src/index.ts) is the boundary. */
export interface AntigravityTaskArgs {
  readonly task: string;
  readonly model?: string;
  readonly timeoutSeconds?: number;
  readonly continueConversation?: boolean;
  readonly conversationId?: string;
  readonly mode?: Mode;
  readonly sandbox?: boolean;
}

/**
 * Minimal execution context the plugin derives from ToolContext. `onProgress`
 * is the only progress channel: the plugin wires it to OpenCode metadata, so
 * the core runner never sees ToolContext.
 */
export interface RunnerContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (update: ProgressUpdate) => void;
}

/** Runner lifecycle progress beyond the protocol events: start + terminal. */
export type ProgressUpdate =
  | ProgressSnapshot
  | { readonly event: "start" }
  | {
      readonly event: "terminal";
      readonly kind: "success" | RunnerFailureKind;
      readonly conversationId: string | null;
      readonly totalTokens: number | null;
    };

/**
 * Isolated progress dispatch: progress is best-effort by contract, so a
 * throwing consumer must never fail the run or alter the payload.
 */
export function emitProgress(context: RunnerContext, update: ProgressUpdate): void {
  if (context.onProgress !== undefined) {
    try {
      context.onProgress(update);
    } catch {
      // Isolated: a throwing progress consumer never fails the run.
    }
  }
}

/** The authoritative terminal update derived from the final metadata. */
export function terminalProgress(metadata: AntigravityTaskMetadata): ProgressUpdate {
  return {
    event: "terminal",
    kind: metadata.kind,
    conversationId: metadata.conversationId,
    totalTokens: metadata.usage.total_tokens,
  };
}

/**
 * Injectable adapter seam: tests substitute fakes here so no real agy process
 * or network is ever touched. Discovery options mirror Todo 4's DiscoveryOptions.
 */
export interface RunnerDeps {
  readonly injected: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform | undefined;
  readonly resolveAgy: (options: DiscoveryOptions) => string;
  readonly runAgy: (options: SpawnOptions) => Promise<ProcessResult>;
}

/** Every distinguishable bounded failure the runner can return. */
export type RunnerFailureKind =
  | "empty-task"
  | "invalid-timeout"
  | "conversation-conflict"
  | "empty-path"
  | "resolve-not-found"
  | "resolve-not-executable"
  | "spawn-failed"
  | "timeout"
  | "aborted"
  | "stdout-overflow"
  | "stderr-overflow"
  | "status"
  | "duplicate-result"
  | "missing-result"
  | "invalid-result"
  | "empty-output"
  | "nonzero-exit";

/** Redacted, bounded diagnostic text cap (chars after redaction). */
export const MAX_DIAGNOSTIC_CHARS = 2_000;
/** Suffix appended when redacted diagnostic text exceeds the cap. */
export const DIAGNOSTIC_TRUNCATION_SUFFIX = "\n[diagnostic truncated]";

/**
 * Shared bounded-diagnostic policy: redact the known cwd and credential-like
 * values FIRST, then truncate, so truncation cannot split a credential before
 * it is recognized. Used for stderr excerpts and ProcessError messages alike.
 */
export function boundDiagnosticText(text: string, cwd: string | undefined): string {
  const withoutCwd = cwd !== undefined && cwd.length > 1 ? text.split(cwd).join("[cwd]") : text;
  const redacted = redactCredentials(withoutCwd);
  if (redacted.length <= MAX_DIAGNOSTIC_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_DIAGNOSTIC_CHARS)}${DIAGNOSTIC_TRUNCATION_SUFFIX}`;
}

function assertNever(value: never): never {
  throw new Error(`unreachable diagnostic: ${String(value)}`);
}

/**
 * Runner-boundary sanitization of parser diagnostics: only free-text fields are
 * transformed. Currently only malformed-line context carries free text; kind,
 * lineNumber, bytes, name and the parser's own caps are preserved exactly.
 */
export function sanitizeDiagnostics(diagnostics: readonly Diagnostic[], cwd: string | undefined): readonly Diagnostic[] {
  return diagnostics.map((diagnostic) => {
    switch (diagnostic.kind) {
      case "malformed-line":
        return { kind: "malformed-line", lineNumber: diagnostic.lineNumber, context: boundDiagnosticText(diagnostic.context, cwd) };
      case "unknown-event":
        return diagnostic;
      case "invalid-event-payload":
        return diagnostic;
      case "line-too-long":
        return diagnostic;
      case "output-truncated":
        return diagnostic;
      default:
        return assertNever(diagnostic);
    }
  });
}

/** Concise, machine-stable provenance/risk note; sandbox never promises file-write protection. */
export function riskNote(mode: Mode, sandbox: boolean | undefined): string {
  if (mode === "execute") {
    return sandbox === true
      ? "execute mode may modify files in the current workspace; sandbox restricts only terminal/shell access"
      : "execute mode may modify files in the current workspace";
  }
  return sandbox === true
    ? "plan mode requests planning without applying edits, but does not guarantee filesystem immutability; sandbox restricts only terminal/shell access"
    : "plan mode requests planning without applying edits, but does not guarantee filesystem immutability";
}

/** Typed success/failure surface the tool returns inside `{title, output, metadata}`. */
export type AntigravityTaskMetadata =
  | {
      readonly ok: true;
      readonly kind: "success";
      readonly status: "SUCCESS";
      readonly text: string;
      readonly conversationId: string;
      readonly usage: Usage;
      readonly exit: ProcessExit;
      readonly provenance: string;
      readonly diagnostics: readonly Diagnostic[];
      readonly droppedDiagnostics: number;
      readonly stderr: string;
    }
  | {
      readonly ok: false;
      readonly kind: RunnerFailureKind;
      readonly status: Status | null;
      readonly message: string;
      readonly conversationId: string | null;
      readonly usage: Usage;
      readonly exit: ProcessExit | null;
      readonly provenance: string;
      readonly diagnostics: readonly Diagnostic[];
      readonly droppedDiagnostics: number;
      readonly stderr: string;
    };

/** Shape returned by the tool; structurally assignable to the framework ToolResult. */
export interface ToolPayload {
  readonly title: string;
  readonly output: string;
  readonly metadata: AntigravityTaskMetadata;
}
