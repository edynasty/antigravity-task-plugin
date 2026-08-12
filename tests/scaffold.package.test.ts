import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import {
  FIXTURE_PATH,
  PACKAGE_JSON_PATH,
  SRC_INDEX_PATH,
  readPackageManifest,
} from "./helpers/fake-agy-harness";

// Type-level contract probe: the declared peer/dev @opencode-ai/plugin resolves
// the Plugin type that Todo 5 will consume. Fails at typecheck if the dependency
// contract drifts.
export type PluginTypeProbe = Plugin;

describe("package scaffold contract", () => {
  test("scaffold artifacts exist: src/index.ts, fake-agy fixture, package.json", () => {
    expect(existsSync(SRC_INDEX_PATH)).toBe(true);
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    expect(existsSync(PACKAGE_JSON_PATH)).toBe(true);
  });

  test("src/index.ts exports package identity matching package.json", async () => {
    expect(existsSync(SRC_INDEX_PATH)).toBe(true);
    const { PACKAGE_IDENTITY } = await import("../src/index");
    const manifest = readPackageManifest();
    expect(manifest.name).toBe(PACKAGE_IDENTITY.name);
    expect(manifest.version).toBe(PACKAGE_IDENTITY.version);
  });

  test("package.json declares the six required scripts", () => {
    const manifest = readPackageManifest();
    for (const script of ["test", "test:coverage", "typecheck", "build", "test:integration", "test:live"]) {
      expect(manifest.scripts[script], `script ${script} must be declared`).toBeDefined();
    }
  });

  test("@opencode-ai/plugin peer dependency range admits installed 1.18.x", () => {
    const manifest = readPackageManifest();
    const peer = manifest.peerDependencies?.["@opencode-ai/plugin"];
    expect(peer, "peerDependencies.@opencode-ai/plugin must be declared").toBeDefined();
    const range = peer ?? "";
    // The range must accept 1.18.x (>= / ^) without a second Zod major conflict.
    expect(range.startsWith(">=") || range.startsWith("^")).toBe(true);
  });

  test("package files list excludes tests, .omo, node_modules and source; includes dist", () => {
    const manifest = readPackageManifest();
    const files = manifest.files;
    expect(files, "files field must be declared").toBeDefined();
    expect(files?.includes("dist")).toBe(true);
    expect(files?.includes("tests")).toBe(false);
    expect(files?.includes(".omo")).toBe(false);
    expect(files?.includes("node_modules")).toBe(false);
    expect(files?.includes("src")).toBe(false);
  });
});
