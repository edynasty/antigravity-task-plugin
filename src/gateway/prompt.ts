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
 * Roles other than system/user/assistant are rejected at the boundary; content
 * must be a plain string (OpenAI's array-of-parts content is out of scope).
 * The `mode` field is a separate request field passed to `--mode` as a CLI
 * flag — it is NEVER injected into this prompt text.
 */

export const PROMPT_ROLES = ["system", "user", "assistant"] as const;
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
      return { ok: false, reason: `message ${index} role must be one of system, user, assistant` };
    }
    const content = raw["content"];
    if (typeof content !== "string") {
      return { ok: false, reason: `message ${index} content must be a string` };
    }
    messages.push({ role, content });
  }
  return { ok: true, messages, prompt: promptFromMessages(messages) };
}

export function promptFromMessages(messages: readonly OpenAIMessage[]): string {
  return messages.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`).join("\n\n");
}
