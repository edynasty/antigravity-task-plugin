/**
 * OpenAI messages -> agy task prompt conversion (gateway boundary).
 *
 * The framing is the documented gateway contract:
 *
 *   <system>
 *   <system content verbatim>
 *   </system>
 *
 *   <user>
 *   <user content verbatim>
 *   </user>
 *
 *   <assistant>
 *   <assistant content verbatim>
 *   </assistant>
 *
 * Roles: system/user/assistant are mapped to their tags; the OpenAI `tool`
 * role is accepted and framed as `<tool>`. Content accepts both a plain
 * string and OpenAI's array-of-parts form: `text` parts are joined, image and
 * other non-text parts are dropped (agy's prompt is plain text, so images
 * cannot be passed); null/missing content becomes an empty string.
 * The `mode` field is a separate request field passed to `--mode` as a CLI
 * flag — it is NEVER injected into this prompt text.
 */

export const PROMPT_ROLES = ["system", "user", "assistant", "tool"] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];

export interface OpenAIMessage {
  readonly role: PromptRole;
  readonly content: string;
}

export type PromptParse =
  | { readonly ok: true; readonly messages: readonly OpenAIMessage[]; readonly prompt: string }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleOf(value: unknown): PromptRole | null {
  return typeof value === "string" && (PROMPT_ROLES as readonly string[]).includes(value) ? (value as PromptRole) : null;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part) || part["type"] !== "text" || typeof part["text"] !== "string") {
          return "";
        }
        return part["text"];
      })
      .filter((part) => part !== "")
      .join("\n");
  }
  return "";
}

export function parsePrompt(value: unknown): PromptParse {
  if (!isRecord(value) || !Array.isArray(value["messages"])) {
    return { ok: false, reason: "messages must be an array" };
  }
  const rawMessages = value["messages"];
  if (rawMessages.length === 0) {
    return { ok: false, reason: "messages must not be empty" };
  }
  const messages: OpenAIMessage[] = [];
  for (let index = 0; index < rawMessages.length; index += 1) {
    const raw = rawMessages[index];
    if (!isRecord(raw)) {
      return { ok: false, reason: `message ${index} must be an object` };
    }
    const role = roleOf(raw["role"]);
    if (role === null) {
      return { ok: false, reason: `message ${index} role must be one of ${PROMPT_ROLES.join(", ")}` };
    }
    const content = raw["content"];
    if (typeof content !== "string" && content !== null && content !== undefined && !Array.isArray(content)) {
      return { ok: false, reason: `message ${index} content must be a string or an array of parts` };
    }
    messages.push({ role, content: contentToString(content) });
  }
  const toolsPrompt = toolsToPrompt(value["tools"]);
  const prompt = `${HOST_EXECUTION_DIRECTIVE}\n\n${toolsPrompt === "" ? "" : `${toolsPrompt}\n\n`}${promptFromMessages(messages)}`;
  return { ok: true, messages, prompt };
}

/** Tells agy how the bridge works: the container mounts the user's project at
 * /workspace so reads succeed, its tool calls are mirrored on the host, and
 * side-effecting changes are only ever made by the host (never in the
 * container, where they would be duplicated and diverge). */
export const HOST_EXECUTION_DIRECTIVE =
  "You are running inside a container with the user's project mounted at /workspace.\n" +
  "You MAY read files and run read-only commands there - they operate on the real project.\n" +
  "Your tool calls are also executed on the host and their results are fed back to you as <tool> blocks.\n" +
  "Never modify files or run commands with side effects: changes must only be made by the host.";

function toolsToPrompt(tools: unknown): string {
  if (!Array.isArray(tools)) {
    return "";
  }
  const lines: string[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || !isRecord(tool["function"])) {
      continue;
    }
    const fn = tool["function"];
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (name === "") {
      continue;
    }
    const description = typeof fn["description"] === "string" ? fn["description"] : "";
    lines.push(`- ${name}${description === "" ? "" : `: ${description}`}`);
  }
  if (lines.length === 0) {
    return "";
  }
  return `<tools>\n${lines.join("\n")}\n</tools>`;
}

export function promptFromMessages(messages: readonly OpenAIMessage[]): string {
  return messages.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`).join("\n\n");
}
