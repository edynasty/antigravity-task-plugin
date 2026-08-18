/**
 * Final tool title composition: `antigravity-task: {kind} ({model}) — {excerpt}`.
 * The model comes from the agy init line already parsed into metadata; the
 * excerpt is the first non-empty task line, credentials redacted BEFORE the
 * 60-char bound so truncation can never split a credential. Progress-update
 * titles (src/index.ts) are untouched: only the terminal payload title is
 * composed here.
 */
import { redactCredentials } from "./redaction.js";

/** Hard cap on the composed final tool title (chars). */
export const MAX_TITLE_CHARS = 140;
/** Excerpt length cap for the task line in the final title (chars). */
export const MAX_TITLE_EXCERPT_CHARS = 60;
/** Suffix appended when the title excerpt is truncated. */
export const TITLE_TRUNCATION_SUFFIX = "…";
/** Placeholder shown when the task has no usable first line. */
export const NO_TASK_PLACEHOLDER = "(no task)";

/**
 * Bounded, redacted first-line task excerpt for the final title.
 */
export function titleExcerpt(task: string): string {
  let line = "";
  for (const candidate of task.split("\n")) {
    const trimmed = candidate.trim();
    if (trimmed !== "") {
      line = trimmed;
      break;
    }
  }
  if (line === "") {
    return NO_TASK_PLACEHOLDER;
  }
  const redacted = redactCredentials(line);
  return redacted.length > MAX_TITLE_EXCERPT_CHARS
    ? `${redacted.slice(0, MAX_TITLE_EXCERPT_CHARS)}${TITLE_TRUNCATION_SUFFIX}`
    : redacted;
}

/** Compose the final tool title from the terminal metadata. */
export function composeTitle(
  kind: "SUCCESS" | string,
  model: string | null,
  task: string,
): string {
  const modelLabel = model === null ? "unknown" : model;
  return `antigravity-task: ${kind} (${modelLabel}) — ${titleExcerpt(task)}`;
}
