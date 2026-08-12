/**
 * Validation matrix for the hardened opt-in load probe contract (Todo 6
 * security + freshness remediation). The probe must never write outside a
 * verified system-temp integration root and the proof must be bound to this
 * invocation: both env vars plus a per-run nonce are required, the root must
 * be a real (non-symlink) directory under canonical tmpdir() whose basename
 * matches the exact mkdtemp shape (prefix + six-character suffix), and the
 * marker must be its exact direct-child basename. The marker write is
 * exclusive (wx) so a precreated file fails the load instead of replaying a
 * stale proof. Any mismatch throws a bounded error WITHOUT writing; all three
 * vars absent = zero probe I/O.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_LOAD_MARKER_BASENAME,
  PLUGIN_LOAD_MARKER_ENV,
  PLUGIN_LOAD_NONCE_ENV,
  PLUGIN_LOAD_ROOT_ENV,
  probeMarkerContent,
  validateProbeContract,
} from "../src/plugin-probe.js";

const NONCE = "a".repeat(32);

async function withProbeEnv(
  root: string | undefined,
  marker: string | undefined,
  nonce: string | undefined,
  body: () => Promise<void> | void,
): Promise<void> {
  const previousRoot = process.env[PLUGIN_LOAD_ROOT_ENV];
  const previousMarker = process.env[PLUGIN_LOAD_MARKER_ENV];
  const previousNonce = process.env[PLUGIN_LOAD_NONCE_ENV];
  setOrDelete(PLUGIN_LOAD_ROOT_ENV, root);
  setOrDelete(PLUGIN_LOAD_MARKER_ENV, marker);
  setOrDelete(PLUGIN_LOAD_NONCE_ENV, nonce);
  try {
    await body();
  } finally {
    setOrDelete(PLUGIN_LOAD_ROOT_ENV, previousRoot);
    setOrDelete(PLUGIN_LOAD_MARKER_ENV, previousMarker);
    setOrDelete(PLUGIN_LOAD_NONCE_ENV, previousNonce);
  }
}

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
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

  test("all three env vars absent is valid (zero probe I/O contract)", () => {
    expect(validateProbeContract(undefined, undefined, undefined)).toBeUndefined();
  });

  test("only the root var present is rejected", () => {
    expect(validateProbeContract(validRoot, undefined, undefined)).toMatch(/both|all three/);
  });

  test("only the marker var present is rejected", () => {
    expect(validateProbeContract(undefined, validMarker, undefined)).toMatch(/both|all three/);
  });

  test("a missing nonce is rejected even with root and marker", () => {
    expect(validateProbeContract(validRoot, validMarker, undefined)).toMatch(/nonce/i);
  });

  test("a non-hex nonce is rejected", () => {
    expect(validateProbeContract(validRoot, validMarker, "not-hex!")).toMatch(/nonce/);
  });

  test("a root outside canonical tmpdir is rejected without writing", () => {
    const outside = mkdtempSync(join(tmpRoot, "not-our-prefix-"));
    const marker = join(outside, PLUGIN_LOAD_MARKER_BASENAME);
    try {
      const error = validateProbeContract(outside, marker, NONCE);
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
      expect(validateProbeContract(wrong, marker, NONCE)).toMatch(/prefix/);
    } finally {
      rmSync(wrong, { recursive: true, force: true });
    }
  });

  test("a root whose basename matches the prefix but has an arbitrary suffix is rejected", () => {
    const wrong = mkdtempSync(join(tmpRoot, "antigravity-task-plugin-int-not-a-mkdtemp-suffix"));
    const marker = join(wrong, PLUGIN_LOAD_MARKER_BASENAME);
    try {
      expect(validateProbeContract(wrong, marker, NONCE)).toMatch(/prefix|six|6-char|suffix/);
    } finally {
      rmSync(wrong, { recursive: true, force: true });
    }
  });

  test("a traversal marker path is rejected", () => {
    expect(validateProbeContract(validRoot, join(validRoot, "..", "escaped", PLUGIN_LOAD_MARKER_BASENAME), NONCE)).toMatch(
      /marker/,
    );
  });

  test("a symlinked root is rejected", () => {
    const realTarget = mkdtempSync(join(tmpRoot, "antigravity-task-plugin-int-"));
    const linkPath = join(tmpRoot, "antigravity-task-plugin-int-link");
    symlinkSync(realTarget, linkPath);
    try {
      expect(validateProbeContract(linkPath, join(linkPath, PLUGIN_LOAD_MARKER_BASENAME), NONCE)).toMatch(/symlink/);
    } finally {
      rmSync(realTarget, { recursive: true, force: true });
      rmSync(linkPath, { recursive: true, force: true });
    }
  });

  test("a wrong marker basename is rejected", () => {
    expect(validateProbeContract(validRoot, join(validRoot, "other.marker"), NONCE)).toMatch(/marker/);
  });

  test("a valid generated root + exact marker + hex nonce passes", () => {
    expect(validateProbeContract(validRoot, validMarker, NONCE)).toBeUndefined();
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
    await withProbeEnv(validRoot, target, NONCE, () => {
      expect(validateProbeContract(process.env[PLUGIN_LOAD_ROOT_ENV], process.env[PLUGIN_LOAD_MARKER_ENV], process.env[PLUGIN_LOAD_NONCE_ENV])).toMatch(/marker/);
    });
    expect(existsSync(join(tmpRoot, "escaped-write.marker"))).toBe(false);
  });

  test("a marker in a subdirectory is rejected (must be exact direct child)", () => {
    const nestedMarker = join(validRoot, "sub", PLUGIN_LOAD_MARKER_BASENAME);
    expect(validateProbeContract(validRoot, nestedMarker, NONCE)).toMatch(/marker/);
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

  test("plugin entry writes the nonce-bound marker in a verified root", async () => {
    const marker = join(validRoot, PLUGIN_LOAD_MARKER_BASENAME);
    const pluginEntry = (await import("../src/plugin")).default as () => Promise<unknown>;
    await withProbeEnv(validRoot, marker, NONCE, async () => {
      await pluginEntry();
      expect(readFileSync(marker, "utf8")).toBe(probeMarkerContent(NONCE));
    });
  });

  test("a precreated marker cannot replay the proof (exclusive create fails)", async () => {
    const marker = join(validRoot, PLUGIN_LOAD_MARKER_BASENAME);
    writeFileSync(marker, "stale-replayed-proof\n");
    const pluginEntry = (await import("../src/plugin")).default as () => Promise<unknown>;
    await withProbeEnv(validRoot, marker, NONCE, async () => {
      expect(pluginEntry()).rejects.toThrow();
    });
    expect(readFileSync(marker, "utf8")).toBe("stale-replayed-proof\n");
  });

  test("plugin entry performs zero probe I/O when all env vars are absent", async () => {
    const marker = join(validRoot, "must-not-exist.marker");
    const pluginEntry = (await import("../src/plugin")).default as () => Promise<unknown>;
    await withProbeEnv(undefined, undefined, undefined, async () => {
      await pluginEntry();
    });
    expect(existsSync(marker)).toBe(false);
  });
});
