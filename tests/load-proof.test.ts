/**
 * Load-proof checker tests for the isolated OpenCode loading harness (Todo 6).
 *
 * The real E2E gate runs in tests/integration-harness.ts via
 * `bun run test:integration`; helper-contract tests are split by
 * responsibility so every file stays <= 250 pure LOC. This file locks the
 * strict proof checker: the marker content must be bound to the per-run
 * nonce (freshness — a precreated fixed marker must NOT replay the proof),
 * the exact expected entry must be listed, exit 0 is required, and no
 * legacy-loader error may appear in the logs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPluginLoadProof } from "./helpers/load-proof";
import { formatHashLine } from "./helpers/integration-harness";
import { probeMarkerContent } from "../src/plugin-probe.js";

describe("checkPluginLoadProof", () => {
  let proofRoot: string;
  const ENTRY = "file:///tmp/install/package/dist/plugin.js";
  const NONCE = "a".repeat(32);
  const LISTED = `opencode version: 1.18.16\nplugins:\n- ${ENTRY}\n`;

  beforeAll(async () => {
    proofRoot = await mkdtemp(join(tmpdir(), "antigravity-proof-"));
  });

  afterAll(async () => {
    await rm(proofRoot, { recursive: true, force: true });
  });

  test("passes only with exit 0, exact expected entry, nonce-bound marker, and no loader error", async () => {
    const markerPath = join(proofRoot, "proof-ok.marker");
    await writeFile(markerPath, probeMarkerContent(NONCE));

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: LISTED,
      stderr: "unrelated noise",
      expectedEntry: ENTRY,
      markerPath,
      expectedNonce: NONCE,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("fails when a DIFFERENT plugin is listed even with exit 0 and no errors", async () => {
    const markerPath = join(proofRoot, "proof-unrelated.marker");
    await writeFile(markerPath, probeMarkerContent(NONCE));
    const unrelatedList = "opencode version: 1.18.16\nplugins:\n- file:///other/plugin.js\n";

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: unrelatedList,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
      expectedNonce: NONCE,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expected entry/);
  });

  test("fails when the expected entry is entirely missing from the plugins list", async () => {
    const markerPath = join(proofRoot, "proof-missing-entry.marker");
    await writeFile(markerPath, probeMarkerContent(NONCE));

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: "opencode version: 1.18.16\nplugins:\n",
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
      expectedNonce: NONCE,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expected entry/);
  });

  test("fails on nonzero exit even when entry is listed and marker exists", async () => {
    const markerPath = join(proofRoot, "proof-nonzero.marker");
    await writeFile(markerPath, probeMarkerContent(NONCE));

    const result = await checkPluginLoadProof({
      exitCode: 3,
      stdout: LISTED,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
      expectedNonce: NONCE,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/exit/);
  });

  test("fails when the marker is absent even with entry listed, exit 0, and no errors", async () => {
    const markerPath = join(proofRoot, "proof-no-marker.marker");

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: LISTED,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
      expectedNonce: NONCE,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/marker/);
  });

  test("fails when the marker content does not carry THIS run's nonce (replay blocked)", async () => {
    const markerPath = join(proofRoot, "proof-replay.marker");
    await writeFile(markerPath, "antigravity-task-plugin-factory-executed\n");

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: LISTED,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
      expectedNonce: NONCE,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/marker/);
  });

  test("fails when the nonce in the marker differs from the expected nonce", async () => {
    const markerPath = join(proofRoot, "proof-wrong-nonce.marker");
    await writeFile(markerPath, probeMarkerContent("b".repeat(32)));

    const result = await checkPluginLoadProof({
      exitCode: 0,
      stdout: LISTED,
      stderr: "",
      expectedEntry: ENTRY,
      markerPath,
      expectedNonce: NONCE,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/marker/);
  });

  test("reads the marker content as written (nonce-bound contract)", async () => {
    const markerPath = join(proofRoot, "proof-content.marker");
    await writeFile(markerPath, probeMarkerContent(NONCE));

    const content = await readFile(markerPath, "utf8");

    expect(content).toBe(`antigravity-task-plugin-factory-executed:${NONCE}\n`);
  });
});

describe("formatHashLine", () => {
  test("renders ABSENT distinctly from any present digest", () => {
    const line = formatHashLine("/tmp/config.jsonc", "ABSENT");
    expect(line).toContain("/tmp/config.jsonc");
    expect(line).toContain("ABSENT");
    expect(line).not.toMatch(/[0-9a-f]{64}/);
  });

  test("renders a present sha256 digest", () => {
    const digest = "a".repeat(64);
    const line = formatHashLine("/tmp/config.jsonc", digest);
    expect(line).toContain("/tmp/config.jsonc");
    expect(line).toContain(digest);
    expect(line).not.toContain("ABSENT");
  });
});
