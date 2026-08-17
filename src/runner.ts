/**
 * Todo 5 runner: composes executable discovery (resolveAgy), deterministic
 * argv (buildArgv), subprocess lifecycle (runAgy) and the incremental protocol
 * parser (NdjsonStreamParser) into one bounded tool execution without
 * duplicating any of their responsibilities. Metadata assembly and the final
 * execution-detail block live in metadata.ts; stderr and diagnostic text are
 * redacted and bounded there.
 */
import { ArgsError, DEFAULT_MODE, DEFAULT_TIMEOUT_SECONDS, buildArgv } from "./args.js";
import { NdjsonStreamParser } from "./protocol.js";
import { HOST_GRACE_MS, ProcessError, ResolveError } from "./process-types.js";
import type { ProcessExit } from "./process-types.js";
import { resolveAgy, runAgy } from "./process.js";
import type { DiscoveryOptions, ProcessResult } from "./process.js";
import { metadataFromParser, payloadFromMetadata, processFailure, resolveFailure, validationMetadata } from "./metadata.js";
import {
  emitProgress,
  riskNote,
  terminalProgress,
  type AntigravityTaskArgs,
  type AntigravityTaskMetadata,
  type RunnerContext,
  type RunnerDeps,
  type ToolPayload,
} from "./runner-types.js";

export const defaultDeps: RunnerDeps = {
  injected: undefined,
  env: process.env,
  platform: process.platform,
  resolveAgy,
  runAgy,
};

function discoveryOptions(deps: RunnerDeps): DiscoveryOptions {
  return {
    env: deps.env,
    ...(deps.injected !== undefined ? { injected: deps.injected } : {}),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  };
}

export async function runAntigravityTask(
  args: AntigravityTaskArgs,
  context: RunnerContext,
  deps: RunnerDeps = defaultDeps,
): Promise<ToolPayload> {
  const provenance = riskNote(args.mode ?? DEFAULT_MODE, args.sandbox);
  const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  emitProgress(context, { event: "start" });

  const parser = new NdjsonStreamParser({ onProgress: (snapshot) => emitProgress(context, snapshot) });
  const finish = (metadata: AntigravityTaskMetadata): ToolPayload => {
    emitProgress(context, terminalProgress(metadata));
    return payloadFromMetadata(args, metadata);
  };

  let argv: readonly string[];
  try {
    argv = buildArgv(args);
  } catch (error) {
    if (error instanceof ArgsError) {
      return finish(validationMetadata(error, provenance));
    }
    throw error;
  }

  let executable: string;
  try {
    executable = deps.resolveAgy(discoveryOptions(deps));
  } catch (error) {
    if (error instanceof ResolveError) {
      return finish(resolveFailure(error.kind, provenance));
    }
    throw error;
  }

  let proc: ProcessResult;
  try {
    proc = await deps.runAgy({
      argv: [executable, ...argv],
      cwd: context.cwd,
      env: deps.env,
      signal: context.signal,
      hostTimeoutMs: timeoutSeconds * 1000 + HOST_GRACE_MS,
      onStdoutChunk: (chunk) => parser.push(chunk),
    });
  } catch (error) {
    if (error instanceof ProcessError) {
      return finish(processFailure(error, provenance, context.cwd));
    }
    throw error;
  }

  const parsed = parser.finish();
  const exit: ProcessExit = { exitCode: proc.exitCode, signal: proc.signal };
  return finish(metadataFromParser(parsed, exit, provenance, proc.stderr, context.cwd));
}
