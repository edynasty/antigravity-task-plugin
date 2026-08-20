export interface WorkspaceMount {
  readonly hostPath: string;
  readonly containerPath: string;
}

/** Parse workspace mounts from env: AGY_GATEWAY_WORKSPACE (single, host path
 * mounted at /workspace) plus AGY_GATEWAY_WORKSPACES (comma-separated
 * hostPath=containerPath pairs for multiple workspaces/sessions). */
export function parseWorkspaceMounts(env: Record<string, string | undefined>): readonly WorkspaceMount[] {
  const mounts: WorkspaceMount[] = [];
  const single = env["AGY_GATEWAY_WORKSPACE"];
  if (single !== undefined && single !== "") {
    mounts.push({ hostPath: single, containerPath: "/workspace" });
  }
  const multi = env["AGY_GATEWAY_WORKSPACES"];
  if (multi !== undefined && multi !== "") {
    for (const entry of multi.split(",")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const hostPath = entry.slice(0, eq).trim();
      const containerPath = entry.slice(eq + 1).trim();
      if (hostPath !== "" && containerPath !== "") {
        mounts.push({ hostPath, containerPath });
      }
    }
  }
  return mounts;
}