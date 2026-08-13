/**
 * Environment variable names shared between the process fixture
 * (tests/fixtures/process-fixture.ts) and the harness that drives it
 * (tests/helpers/process-harness.ts). Kept in a pure constants module so
 * importing the names never executes the self-running fixture.
 */
export const PROC_SCENARIO_ENV = "AGY_PROC_SCENARIO";
export const PID_PATH_ENV = "AGY_PID_PATH";
export const RECORD_PATH_ENV = "AGY_RECORD_PATH";
export const EXIT_CODE_ENV = "AGY_EXIT_CODE";
export const STDERR_LINES_ENV = "AGY_STDERR_LINES";
export const STDOUT_LINES_ENV = "AGY_STDOUT_LINES";
export const ENV_PROBE_ENV = "AGY_ENV_PROBE";
export const CHILD_PID_PATH_ENV = "AGY_CHILD_PID_PATH";
export const NDJSON_STREAM_ENV = "AGY_NDJSON_STREAM";
export const NDJSON_DELAY_ENV = "AGY_NDJSON_DELAY_MS";
