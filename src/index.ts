/**
 * Package identity contract for the scaffold (Todo 2).
 *
 * This entrypoint intentionally does NOT register an OpenCode tool yet — the
 * `Plugin` export and the `antigravity-task` tool arrive in Todo 5. Consumers
 * of this scaffold rely on `PACKAGE_IDENTITY`; tests/scaffold.test.ts asserts
 * it stays in sync with package.json metadata.
 */
export const PACKAGE_IDENTITY = {
  name: "antigravity-task-plugin",
  version: "0.0.0",
} as const;

export type PackageIdentity = typeof PACKAGE_IDENTITY;
