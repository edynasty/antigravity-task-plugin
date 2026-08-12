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
import type { AntigravityTaskArgs, RunnerDeps, ToolPayload } from "./runner-types.js";

export const PACKAGE_IDENTITY = {
  name: "antigravity-task-plugin",
  version: "0.0.0",
} as const;

export type PackageIdentity = typeof PACKAGE_IDENTITY;

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
      return runAntigravityTask(toInteriorArgs(args), { cwd: context.directory, signal: context.abort }, deps);
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
