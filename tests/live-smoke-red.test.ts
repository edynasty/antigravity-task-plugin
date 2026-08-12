/**
 * RED test: catches the literal-spawn bug in live-smoke.ts.
 *
 * Creates a fake executable at a temp AGY_PATH, sets ANTIGRAVITY_SMOKE=1,
 * runs the smoke, and asserts the fake executable was actually executed
 * (not literal "agy"). The fake emits official NDJSON with PONG, conversation
 * ID, nonzero usage, and records argv/cwd/PID to a file for assertion.
 *
 * This test FAILS against the current live-smoke.ts (line 126 spawns literal
 * "agy" instead of the resolved AGY_PATH), proving the defect.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SMOKE_SCRIPT = "tests/live-smoke.ts";

describe("live smoke executes resolved AGY_PATH (RED)", () => {
  test("fake executable at AGY_PATH is actually executed, not literal 'agy'", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "antigravity-smoke-red-"));
    const fakeAgyPath = join(tempRoot, "fake-agy");
    const recordFile = join(tempRoot, "argv-record.txt");

    // Fake executable: emits official NDJSON with PONG, conversation ID, nonzero usage
    // Records argv/cwd/PID to recordFile so we can assert the resolved path was used
    const fakeScript = `#!/bin/sh
echo '{"event":"init","conversation_id":"test-conv-123","init":{"cwd":"'$(pwd)'","tools":[],"permission_mode":"default"}}' > "${recordFile}"
echo "ARGV: $@" >> "${recordFile}"
echo "PID: $$" >> "${recordFile}"
echo '{"event":"step_update","step_update":{"conversation_id":"test-conv-123","step_index":0,"state":"DONE","step_type":"response","text_delta":"PONG","duration_seconds":1,"usage":{"input_tokens":10,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":15}}}'
echo '{"event":"result","result":{"conversation_id":"test-conv-123","status":"SUCCESS","response":"PONG","duration_seconds":1,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":15}}}'
exit 0
`;

    await writeFile(fakeAgyPath, fakeScript, { mode: 0o755 });
    await chmod(fakeAgyPath, 0o755);

    try {
      const result = spawnSync("bun", [SMOKE_SCRIPT], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          ANTIGRAVITY_SMOKE: "1",
          AGY_PATH: fakeAgyPath,
          // Keep PATH to allow bun to run, but ensure "agy" is not on it
        },
        timeout: 15_000,
      });

      // The smoke should succeed (exit 0) because the fake emits valid NDJSON
      const combined = `${result.stdout}\n${result.stderr}`;
      console.log("Smoke output:", combined);
      console.log("Exit status:", result.status);
      console.log("Signal:", result.signal);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PASS");

      // The record file must exist, proving the fake executable was executed
      const record = await readFile(recordFile, "utf8");
      expect(record).toContain("ARGV:");
      expect(record).toContain("PID:");

      // Assert exact plan argv (the smoke must use buildArgv with mode=plan)
      expect(record).toContain("--mode");
      expect(record).toContain("plan");
      expect(record).toContain("--output-format");
      expect(record).toContain("stream-json");
      expect(record).toContain("--print-timeout");
      expect(record).toContain("60s");
      expect(record).toContain("-p");

      // Assert the fake executable path was used (not literal "agy")
      // The record file exists, so the fake was executed
      expect(record.length).toBeGreaterThan(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
