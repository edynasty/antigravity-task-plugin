/**
 * OpenCode plugin entrypoint (Todo 5): registers exactly one tool,
 * `antigravity-task`, that delegates standalone tasks to the official agy CLI
 * and returns the final response, session id, status and token usage.
 * `PACKAGE_IDENTITY` is retained for the Todo 2 scaffold contract.
 *
 * The tool's default `mode=execute` maps to `--mode accept-edits` and MAY
 * modify files in the current workspace; `mode=plan` requests planning without
 * applying edits. `sandbox` restricts only terminal/shell access.
 */
import { tool, type Plugin, type PluginInput, type PluginOptions, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { defaultDeps, runAntigravityTask } from "./runner.js";
import { redactCredentials } from "./redaction.js";
import type { AntigravityTaskArgs, ProgressUpdate, RunnerDeps, ToolPayload } from "./runner-types.js";

export const PACKAGE_IDENTITY = {
  name: "antigravity-task-plugin",
  version: "0.0.5",
} as const;

export type PackageIdentity = typeof PACKAGE_IDENTITY;

/** Minimum wall-clock gap between metadata(title/metadata) UI updates. */
export const PROGRESS_MIN_INTERVAL_MS = 150;
/** Cap on every string field before it crosses into title/metadata. */
export const MAX_PROGRESS_FIELD_CHARS = 200;

export type ProgressMetadata = { readonly title: string; readonly metadata: Record<string, unknown> };

/** Redact the full value first, then bound — truncation can never split a credential. */
function sanitizedString(value: string | null, cap = MAX_PROGRESS_FIELD_CHARS): string | null {
  if (value === null) {
    return null;
  }
  const redacted = redactCredentials(value);
  return redacted.length > cap ? redacted.slice(0, cap) : redacted;
}

function assertNeverProgress(): never {
  throw new Error("unreachable progress update");
}

/** Map a runner ProgressUpdate to a bounded {title, metadata} UI payload. */
export function progressToMetadata(update: ProgressUpdate): ProgressMetadata {
  switch (update.event) {
    case "start":
      return { title: "antigravity-task: starting", metadata: { phase: "starting" } };
    case "init": {
      const metadata: Record<string, unknown> = { phase: "starting" };
      const conversationId = sanitizedString(update.conversationId);
      if (conversationId !== null) {
        metadata["conversationId"] = conversationId;
      }
      const model = sanitizedString(update.model);
      if (model !== null) {
        metadata["model"] = model;
      }
      const agent = sanitizedString(update.agent);
      if (agent !== null) {
        metadata["agent"] = agent;
      }
      const permissionMode = sanitizedString(update.permissionMode);
      if (permissionMode !== null) {
        metadata["permissionMode"] = permissionMode;
      }
      const title = model !== null ? `antigravity-task: starting (${model})` : "antigravity-task: starting";
      return { title, metadata };
    }
    case "step_update": {
      const stepType = sanitizedString(update.stepType);
      const state = sanitizedString(update.state);
      const toolName = sanitizedString(update.toolName);
      let phase: string;
      if (stepType === "tool" && toolName !== null) {
        phase = `running tool ${toolName}`;
      } else {
        phase = stepType !== null ? `step ${String(update.stepIndex)} ${stepType}` : "responding";
      }
      const metadata: Record<string, unknown> = { phase };
      const conversationId = sanitizedString(update.conversationId);
      if (conversationId !== null) {
        metadata["conversationId"] = conversationId;
      }
      if (update.stepIndex !== null) {
        metadata["stepIndex"] = update.stepIndex;
      }
      if (state !== null) {
        metadata["state"] = state;
      }
      if (stepType !== null) {
        metadata["stepType"] = stepType;
      }
      if (toolName !== null) {
        metadata["toolName"] = toolName;
      }
      if (update.elapsedSeconds !== null) {
        metadata["elapsedSeconds"] = update.elapsedSeconds;
      }
      if (update.totalTokens !== null) {
        metadata["totalTokens"] = update.totalTokens;
      }
      return { title: `antigravity-task: ${phase}`, metadata };
    }
    case "terminal": {
      const phase = update.kind === "success" ? "SUCCESS" : update.kind;
      const metadata: Record<string, unknown> = { phase };
      const conversationId = sanitizedString(update.conversationId);
      if (conversationId !== null) {
        metadata["conversationId"] = conversationId;
      }
      if (update.totalTokens !== null) {
        metadata["totalTokens"] = update.totalTokens;
      }
      return { title: `antigravity-task: ${phase}`, metadata };
    }
    default:
      return assertNeverProgress();
  }
}

/**
 * Throttled metadata dispatcher: first update is delivered immediately,
 * trailing updates are coalesced into one pending slot and flushed on demand.
 * The metadata UI callback is the only failure-isolated boundary; a throwing
 * metadata() never fails or aborts the agy task. flush() clears the timer so
 * no update can ever fire after execute settles.
 */
export function createProgressDispatcher(
  metadata: ToolContext["metadata"],
  minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
): { readonly dispatch: (update: ProgressUpdate) => void; readonly flush: () => void } {
  let lastEmit = 0;
  let pending: ProgressMetadata | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emitNow = (update: ProgressMetadata): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastEmit = Date.now();
    pending = null;
    try {
      metadata(update);
    } catch {
      // Isolated UI boundary: a throwing metadata() must not fail the task.
    }
  };

  const dispatch = (update: ProgressUpdate): void => {
    const mapped = progressToMetadata(update);
    if (Date.now() - lastEmit >= minIntervalMs) {
      emitNow(mapped);
      return;
    }
    pending = mapped;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        if (pending !== null) {
          const current = pending;
          pending = null;
          emitNow(current);
        }
      }, minIntervalMs - (Date.now() - lastEmit));
    }
  };

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending !== null) {
      const current = pending;
      pending = null;
      emitNow(current);
    }
  };

  return { dispatch, flush };
}

const antigravityTaskArgs = {
  task: tool.schema
    .string()
    .min(1)
    .refine((value) => value.trim() !== "", "task must not be blank")
    .describe("The standalone task prompt to send to the Antigravity agy CLI."),
  model: tool.schema.string().optional().describe("Optional model identifier for the run."),
  timeoutSeconds: tool.schema
    .number()
    .int()
    .min(10)
    .max(900)
    .default(300)
    .describe("Seconds before the run aborts (integer 10..900, default 300)."),
  continueConversation: tool.schema.boolean().optional().describe("Resume the most recent conversation instead of starting a new one."),
  conversationId: tool.schema.string().optional().describe("Resume a specific conversation by id."),
  mode: tool.schema
    .enum(["execute", "plan"])
    .default("execute")
    .describe("execute applies changes to the workspace (default); plan requests planning without applying edits."),
  sandbox: tool.schema.boolean().optional().describe("Restrict the run's terminal/shell access only (never filesystem writes)."),
};

/** The tool's actual schema object; zod parses tool args at this boundary. */
export const antigravityTaskSchema = tool.schema.object(antigravityTaskArgs);

type AntigravityTaskSchemaOutput = ReturnType<typeof antigravityTaskSchema.parse>;

/**
 * Normalize parsed boundary args into the interior runner contract. Zod output
 * carries `string | undefined`-style optionals; exactOptionalPropertyTypes
 * requires dropping absent keys before they cross into the runner.
 */
export function toInteriorArgs(args: AntigravityTaskSchemaOutput): AntigravityTaskArgs {
  return {
    task: args.task,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
    ...(args.continueConversation !== undefined ? { continueConversation: args.continueConversation } : {}),
    ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
    ...(args.mode !== undefined ? { mode: args.mode } : {}),
    ...(args.sandbox !== undefined ? { sandbox: args.sandbox } : {}),
  };
}

/**
 * Build the antigravity-task tool definition. `deps` is the injectable adapter
 * seam; tests pass fakes so no real agy process or network is ever touched.
 */
export function createAntigravityTaskTool(deps: RunnerDeps = defaultDeps): ToolDefinition {
  return tool({
    description:
      "Delegates a standalone task to the official Antigravity agy CLI and returns the final response, session id, status and token usage. " +
      "DEFAULT mode=execute runs with --mode accept-edits and MAY modify files in the current workspace; mode=plan requests planning without applying edits. " +
      "sandbox restricts only terminal/shell access, never filesystem writes.",
    args: antigravityTaskArgs,
    async execute(args, context: ToolContext): Promise<ToolPayload> {
      const { dispatch, flush } = createProgressDispatcher(context.metadata);
      const onProgress = (update: ProgressUpdate): void => dispatch(update);
      try {
        return await runAntigravityTask(
          toInteriorArgs(args),
          { cwd: context.directory, signal: context.abort, onProgress },
          deps,
        );
      } finally {
        flush();
      }
    },
  });
}

/** Build the OpenCode Plugin (input is ignored; only deps are consumed). */
export function createAntigravityTaskPlugin(deps: RunnerDeps = defaultDeps) {
  return async (_input?: PluginInput, _options?: PluginOptions): Promise<Hooks> => ({
    tool: {
      "antigravity-task": createAntigravityTaskTool(deps),
    },
  });
}

export const AntigravityTaskPlugin = createAntigravityTaskPlugin() satisfies Plugin;

// OpenCode's plugin loader accepts either a named or a default export; both
// bind the same factory instance so exactly one tool is registered per load.
export default AntigravityTaskPlugin;
