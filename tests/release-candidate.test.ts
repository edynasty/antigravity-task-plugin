/**
 * Release-candidate preservation test (Todo 8).
 *
 * The ONLY test that drives the packed-plugin fake-execution matrix end to
 * end: fresh build + npm pack, extract into a fresh temp project (no global
 * install), import the loader-safe packed entry (dist/plugin.js), instantiate
 * the plugin, and invoke the real antigravity-task tool.execute against
 * controlled fake-agy executables — success, ERROR, host timeout and abort.
 * It asserts exact argv (no shell interpolation), the canonical spawn cwd,
 * SUCCESS metadata, authoritative non-doubled usage, the conversation id,
 * documented failure diagnostics, and exact direct-child PID liveness after
 * bounded polling. Nothing touches a real agy, the network, credentials, or
 * live configs; every artifact lives under one generated temp root removed
 * in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  type FakeAgy,
  type PackedPlugin,
  disposePacked,
  makeFakeAgy,
  packedContext,
  preparePackedPlugin,
  readPid,
  waitPidGone,
  withAgyPath,
  withToolTimeout,
} from "./helpers/release-candidate-harness";

let plugin: PackedPlugin;

/** Deterministic conversation id emitted by tests/fixtures/fake-agy.ts. */
const FAKE_AGY_CONVERSATION_ID = "fake-agy-conversation-00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  plugin = await preparePackedPlugin();
}, 120_000);

afterAll(async () => {
  if (plugin !== undefined) {
    await disposePacked(plugin);
  }
});

async function readArgv(fake: FakeAgy): Promise<readonly string[]> {
  return (await readFile(fake.argvFile, "utf8")).trim().split("\n");
}

describe("packed release candidate (antigravity-task)", () => {
  test("success: exact argv, canonical cwd, SUCCESS metadata, non-doubled usage, conversation id", async () => {
    const fake = await makeFakeAgy(plugin, "success", "happy");
    const task = "task; echo PWNED $(rm -rf /) &";

    const result = await withAgyPath(fake, () =>
      plugin.tool.execute({ task }, packedContext(plugin, new AbortController().signal)),
    );

    expect(result.metadata.ok).toBe(true);
    if (!result.metadata.ok) {
      return;
    }
    expect(result.title).toBe("antigravity-task: SUCCESS");
    expect(result.output).toContain("fake-agy success response: deterministic scaffold fixture.");
    expect(result.output).toContain("antigravity-task execution details");
    expect(result.metadata.conversationId).toBe(FAKE_AGY_CONVERSATION_ID);
    expect(result.metadata.usage.total_tokens).toBe(15);
    expect(result.metadata.provenance).toMatch(/execute mode may modify files/);

    expect(await readArgv(fake)).toEqual([
      "-p",
      task,
      "--output-format",
      "stream-json",
      "--print-timeout",
      "300s",
      "--mode",
      "accept-edits",
    ]);
    expect((await readFile(fake.cwdFile, "utf8")).trim()).toBe(plugin.projectDir);

    const pid = await readPid(fake.pidFile);
    expect(await waitPidGone(pid)).toBe(true);
  });

  test("plan mode maps to --mode plan through the packed plugin", async () => {
    const fake = await makeFakeAgy(plugin, "success", "plan");
    const result = await withAgyPath(fake, () =>
      plugin.tool.execute({ task: "analyze only", mode: "plan" }, packedContext(plugin, new AbortController().signal)),
    );

    expect(result.metadata.ok).toBe(true);
    expect(await readArgv(fake)).toEqual([
      "-p",
      "analyze only",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "300s",
      "--mode",
      "plan",
    ]);
  });

  test("ERROR yields a documented status failure through the packed plugin", async () => {
    const fake = await makeFakeAgy(plugin, "error", "err");
    const result = await withAgyPath(fake, () =>
      plugin.tool.execute({ task: "boom" }, packedContext(plugin, new AbortController().signal)),
    );

    expect(result.metadata.ok).toBe(false);
    if (result.metadata.ok) {
      return;
    }
    expect(result.metadata.kind).toBe("status");
    expect(result.metadata.status).toBe("ERROR");
    expect(result.title).toBe("antigravity-task: status");
    expect(result.output).toMatch(/status ERROR/);
    expect(result.metadata.exit?.exitCode).toBe(1);

    const pid = await readPid(fake.pidFile);
    expect(await waitPidGone(pid)).toBe(true);
  });

  test("host timeout terminates the exact direct child and reports a bounded timeout diagnostic", async () => {
    const fake = await makeFakeAgy(plugin, "hang", "timeout");
    const result = await withAgyPath(fake, () =>
      withToolTimeout(
        plugin.tool.execute({ task: "hang", timeoutSeconds: 10 }, packedContext(plugin, new AbortController().signal)),
        40_000,
        "host-timeout scenario",
      ),
    );

    expect(result.metadata.ok).toBe(false);
    if (result.metadata.ok) {
      return;
    }
    expect(result.metadata.kind).toBe("timeout");
    expect(result.output.toLowerCase()).toContain("timeout");
    expect(result.metadata.exit?.exitCode).toBe(143);

    const pid = await readPid(fake.pidFile);
    expect(await waitPidGone(pid, 10_000)).toBe(true);
  }, 45_000);

  test("abort SIGTERMs the direct child which is confirmed gone", async () => {
    const fake = await makeFakeAgy(plugin, "hang", "abort");
    const controller = new AbortController();
    const pending = withAgyPath(fake, () =>
      withToolTimeout(
        plugin.tool.execute({ task: "hang-abort", timeoutSeconds: 10 }, packedContext(plugin, controller.signal)),
        20_000,
        "abort scenario",
      ),
    );
    setTimeout(() => controller.abort(), 1_500);

    const result = await pending;
    expect(result.metadata.ok).toBe(false);
    if (result.metadata.ok) {
      return;
    }
    expect(result.metadata.kind).toBe("aborted");
    expect(result.metadata.exit?.exitCode).toBe(143);

    const pid = await readPid(fake.pidFile);
    expect(await waitPidGone(pid, 10_000)).toBe(true);
  }, 25_000);
});
