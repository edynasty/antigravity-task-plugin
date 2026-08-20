/**
 * Tool-call bridge (gateway Todo 13 / bridge stage 2): maps agy's internal
 * tool steps onto the tool names OpenCode itself registers, so a tool call
 * emitted to the client can actually be executed by the host. Unknown tools
 * are not bridged (the gateway simply does not emit them).
 *
 * The container mounts the user's project at /workspace (host path is
 * supplied via AGY_GATEWAY_WORKSPACE). agy paths under /workspace are
 * rewritten to the host path so the host executes against the real project.
 */

export interface TranslatedToolCall {
  name: string;
  arguments: string;
}

const BASH_TOOLS = new Set(["run_command", "run_command_with_output"]);
const READ_TOOLS = new Set(["view_file", "view_directory"]);

/** Rewrite a container /workspace path to the host path the client sees. */
export function remapPath(value: string, workspaceHostPath: string | null): string {
  if (workspaceHostPath === null || workspaceHostPath === "") {
    return value;
  }
  if (value === "/workspace") {
    return workspaceHostPath;
  }
  if (value.startsWith("/workspace/")) {
    return `${workspaceHostPath}${value.slice("/workspace".length)}`;
  }
  return value;
}

function stringField(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return null;
}

export function translateToolCall(
  toolName: string,
  inputJson: string,
  workspaceHostPath: string | null,
): TranslatedToolCall | null {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (BASH_TOOLS.has(toolName)) {
    const command = stringField(input, ["CommandLine", "command"]);
    if (command === null) {
      return null;
    }
    return { name: "bash", arguments: JSON.stringify({ command: remapPath(command, workspaceHostPath) }) };
  }
  if (READ_TOOLS.has(toolName)) {
    const filePath = stringField(input, ["FilePath", "file_path", "path"]);
    if (filePath === null) {
      return null;
    }
    return { name: "read", arguments: JSON.stringify({ filePath: remapPath(filePath, workspaceHostPath) }) };
  }
  return null;
}