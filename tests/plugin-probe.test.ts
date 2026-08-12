/**
 * Validation matrix for the hardened opt-in load probe contract (Todo 6
 * security remediation). The probe must never write outside a verified
 * system-temp integration root: both env vars are required, the root must be
 * a real (non-symlink) directory under canonical tmpdir() with the harness
 * prefix, and the marker must be its exact direct-child basename. Any
 * mismatch throws a bounded error WITHOUT writing. Both vars absent = zero
 * probe I/O.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_LOAD_MARKER_BASENAME,
  PLUGIN_LOAD_MARKER_CONTENT,
  PLUGIN_LOAD_MARKER_ENV,
  PLUGIN_LOAD_ROOT_ENV,
  validateProbeContract,
} from "../src/plugin-probe.js";

async function withProbeEnv(root: string | undefined, marker: string | undefined, body: () => Promise<void> | void): Promise<void> {
  const previousRoot = process.env[PLUGIN_LOAD_ROOT_ENV];
  const previousMarker = process.env[PLUGIN_LOAD_MARKER_ENV];
  if (root === undefined) {
    delete process.env[PLUGIN_LOAD_ROOT_ENV];
  } else {
    process.env[PLUGIN_LOAD_ROOT_ENV] = root;
  }
  if (marker === undefined) {
    delete process.env[PLUGIN_LOAD_MARKER_ENV];
  } else {
    process.env[PLUGIN_LOAD_MARKER_ENV] = marker;
  }
  try {
    await body();
  } finally {
    if (previousRoot === undefined) {
      delete process.env[PLUGIN_LOAD_ROOT_ENV];
    } else {
      process.env[PLUGIN_LOAD_ROOT_ENV] = previousRoot;
    }
    if (previousMarker === undefined) {
      delete process.env[PLUGIN_LOAD_MARKER_ENV];
    } else {
      process.env[PLUGIN_LOAD_MARKER_ENV] = previousMarker;
    }
  }
}

describe("validateProbeContract", () => {
  let tmpRoot: string;
  let validRoot: string;
  let validMarker: string;

  beforeAll(() => {
    tmpRoot = realpathSync(tmpdir());
    validRoot = mkdtempSync(join(tmpRoot, "antigravity-task-plugin-int-"));
    validMarker = join(validRoot, PLUGIN_LOAD_MARKER_BASENAME);
  });

  afterAll(() => {
    rmSync(validRoot, { recursive: true, force: true });
  });

  test("both env vars absent is valid (zero probe I/O contract)", () => {
    const error = validateProbeContract(undefined, undefined);
    expect(error).toBeUndefined();
  });

  test("only the root var present is rejected", () => {
    const error = validateProbeContract(validRoot, undefined);
    expect(error).toMatch(/both/);
  });

  test("only the marker var present is rejected", () => {
    const error = validateProbeContract(undefined, validMarker);
    expect(error).toMatch(/both/);
  });

  test("a root outside canonical tmpdir is rejected without writing", () => {
    const outside = mkdtempSync(join(tmpRoot, "not-our-prefix-"));
    const marker = join(outside, PLUGIN_LOAD_MARKER_BASENAME);
    try {
      const error = validateProbeContract(outside, marker);
      expect(error).toMatch(/tmp dir|prefix|direct child/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a root with the wrong basename prefix is rejected", () => {
    const wrong = mkdtempSync(join(tmpRoot, "antigravity-task-plugin-other-"));
    const marker = join(wrong, PLUGIN_LOAD_MARKER_BASENAME);
    try {
      const error = validateProbeContract(wrong, marker);
      expect(error).toMatch(/prefix/);
    } finally {
      rmSync(wrong, { recursive: true, force: true });
    }
  });

  test("a traversal marker path is rejected", () => {
    const error = validateProbeContract(validRoot, join(validRoot, "..", "escaped", PLUGIN_LOAD_MARKER_BASENAME));
    expect(error).toMatch(/marker/);
  });

  test("a symlinked root is rejected", () => {
    const realTarget = mkdtempSync(join(tmpRoot, "antigravity-task-plugin-int-"));
    const linkPath = join(tmpRoot, "antigravity-task-plugin-int-link");
    symlinkSync(realTarget, linkPath);
    try {
      const error = validateProbeContract(linkPath, join(linkPath, PLUGIN_LOAD_MARKER_BASENAME));
      expect(error).toMatch(/symlink/);
    } finally {
      rmSync(realTarget, { recursive: true, force: true });
      rmSync(linkPath, { recursive: true, force: true });
    }
  });

  test("a wrong marker basename is rejected", () => {
    const error = validateProbeContract(validRoot, join(validRoot, "other.marker"));
    expect(error).toMatch(/marker/);
  });

  test("a valid generated root + exact marker passes", () => {
    const error = validateProbeContract(validRoot, validMarker);
    expect(error).toBeUndefined();
  });

  test("the valid root is a real directory and not a symlink", () => {
    const stat = lstatSync(validRoot);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
  });
});

describe("probe env contract end to end (no writes on invalid)", () => {
  let tmpRoot: string;
  let validRoot: string;

  beforeAll(() => {
    tmpRoot = realpathSync(tmpdir());
    validRoot = mkdtempSync(join(tmpRoot, "antigravity-task-plugin-int-"));
  });

  afterAll(() => {
    rmSync(validRoot, { recursive: true, force: true });
  });

  test("invalid contract writes nothing on disk", async () => {
    const target = join(validRoot, "..", "escaped-write.marker");
    await withProbeEnv(validRoot, target, () => {
      const error = validateProbeContract(process.env[PLUGIN_LOAD_ROOT_ENV], process.env[PLUGIN_LOAD_MARKER_ENV]);
      expect(error).toMatch(/marker/);
    });
    expect(existsSync(join(tmpRoot, "escaped-write.marker"))).toBe(false);
  });

  test("a marker in a subdirectory is rejected (must be exact direct child)", () => {
    const nestedMarker = join(validRoot, "sub", PLUGIN_LOAD_MARKER_BASENAME);
    const error = validateProbeContract(validRoot, nestedMarker);
    expect(error).toMatch(/marker/);
  });

  test("marker content constant remains fixed and non-secret", () => {
    expect(PLUGIN_LOAD_MARKER_CONTENT).toMatch(/^antigravity-task-plugin-factory-executed\n$/);
    expect(PLUGIN_LOAD_MARKER_CONTENT).not.toMatch(/(?<!ta)sk-[A-Za-z0-9]|Bearer\s|token\s*=|api[_-]?key\s*=|env\b|\.config/i);
  });
});

describe("probe file write through the plugin entry", () => {
  let validRoot: string;

  beforeAll(() => {
    validRoot = mkdtempSync(join(realpathSync(tmpdir()), "antigravity-task-plugin-int-"));
  });

  afterAll(() => {
    rmSync(validRoot, { recursive: true, force: true });
  });

  test("plugin entry writes the exact marker in a verified root when both vars set", async () => {
    const marker = join(validRoot, PLUGIN_LOAD_MARKER_BASENAME);
    const pluginEntry = (await import("../src/plugin")).default as () => Promise<unknown>;
    await withProbeEnv(validRoot, marker, async () => {
      await pluginEntry();
      expect(readFileSync(marker, "utf8")).toBe(PLUGIN_LOAD_MARKER_CONTENT);
    });
  });

  test("plugin entry performs zero probe I/O when both env vars are absent", async () => {
    const marker = join(validRoot, "must-not-exist.marker");
    const pluginEntry = (await import("../src/plugin")).default as () => Promise<unknown>;
    await withProbeEnv(undefined, undefined, async () => {
      await pluginEntry();
    });
    expect(existsSync(marker)).toBe(false);
  });
});
