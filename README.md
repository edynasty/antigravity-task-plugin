# antigravity-task-plugin

OpenCode plugin that delegates standalone tasks to the official [Antigravity agy headless CLI](https://antigravity.google/docs/cli/headless) and returns the final text, session id, status and token usage.

## Prerequisites

| Requirement | Verified version |
|---|---|
| Node.js | >= 20.0.0 |
| OpenCode | 1.18.16 (peer `@opencode-ai/plugin >=1.18.0 <2.0.0`) |
| agy CLI | Installed and on PATH, or path set via `AGY_PATH` |
| Bun (dev only) | 1.3.14+ |

## Installation

### Option A: npm package (loader-safe subpath)

The root package entry (`dist/index.js`) exports constants and schema objects that are NOT safe for OpenCode's legacy plugin loader. Always use the dedicated subpath:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "antigravity-task-plugin/plugin"
  ]
}
```

The `./plugin` and `./server` subpath exports both resolve to `dist/plugin.js`, which exports only the single default plugin factory function. OpenCode's loader iterates all module exports and requires each to be a function; the root entry fails this check.

### Option B: Local tarball

```bash
npm pack
# Produces antigravity-task-plugin-0.0.0.tgz
```

Install the tarball into your OpenCode environment:

```bash
npm install -g ./antigravity-task-plugin-0.0.0.tgz
```

Then reference the installed package in your config:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "antigravity-task-plugin/plugin"
  ]
}
```

Or extract and point at the entry directly:

```bash
tar -xzf antigravity-task-plugin-0.0.0.tgz
```

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/package/dist/plugin.js"
  ]
}
```

### After config change

OpenCode loads plugins once at startup. After editing `opencode.json`, quit and restart OpenCode for changes to take effect.

## Tool arguments

The plugin registers exactly one tool: `antigravity-task`.

While a run is executing, the tool reports live progress through OpenCode's tool metadata (title plus bounded fields such as `phase`, `conversationId`, `stepIndex`, `state`, `stepType`, `elapsedSeconds`, `totalTokens`). Titles follow `antigravity-task: starting`, `antigravity-task: step 3 run_command`, `antigravity-task: responding` and end with `antigravity-task: SUCCESS` (or a failure kind). Updates are throttled; task prompt, raw NDJSON, paths, environment and credentials are never exposed.

| Argument | Type | Default | Description |
|---|---|---|---|
| `task` | `string` | (required) | The standalone task prompt to send to agy. Must be non-empty. |
| `mode` | `"execute" \| "plan"` | `"execute"` | Execute applies changes to the workspace; plan requests planning without applying edits. |
| `timeoutSeconds` | `number` (int) | `300` | Seconds before the run aborts. Range: 10..900. |
| `model` | `string` | (optional) | Model identifier for the run. |
| `conversationId` | `string` | (optional) | Resume a specific conversation by id. Mutually exclusive with `continueConversation`. |
| `continueConversation` | `boolean` | (optional) | Resume the most recent conversation. Mutually exclusive with `conversationId`. |
| `sandbox` | `boolean` | (optional) | Restrict the run's terminal/shell access only. |

## Example calls

The `antigravity-task` tool is invoked by OpenCode's LLM agent. Below are example tool-call payloads showing common usage patterns.

### Default execute mode (may modify workspace)

**⚠️ WARNING: Default `mode=execute` maps to `--mode accept-edits` and MAY modify files in the current worktree.**

```json
{
  "tool": "antigravity-task",
  "args": {
    "task": "Add error handling to the user authentication flow"
  }
}
```

This uses the default `mode=execute`, which allows agy to make changes to your workspace. Review the output before committing.

### Explicit plan mode (planning without applying edits)

```json
{
  "tool": "antigravity-task",
  "args": {
    "task": "Analyze the database schema and suggest optimizations",
    "mode": "plan"
  }
}
```

Plan mode requests planning without applying edits. Note: plan mode does not guarantee filesystem immutability; agy may still read files and reference workspace state in its output.

### With custom timeout and model

```json
{
  "tool": "antigravity-task",
  "args": {
    "task": "Refactor the payment processing module",
    "mode": "plan",
    "timeoutSeconds": 600,
    "model": "claude-3-5-sonnet"
  }
}
```

### Continuation examples

Resume a specific conversation by ID:

```json
{
  "tool": "antigravity-task",
  "args": {
    "task": "Continue implementing the remaining test cases",
    "conversationId": "conv_abc123xyz"
  }
}
```

Or resume the most recent conversation:

```json
{
  "tool": "antigravity-task",
  "args": {
    "task": "Fix the linting errors you found",
    "continueConversation": true
  }
}
```

**Note:** `conversationId` and `continueConversation` are mutually exclusive. Setting both returns an error.

### With sandbox restriction

```json
{
  "tool": "antigravity-task",
  "args": {
    "task": "Run the test suite and report failures",
    "mode": "execute",
    "sandbox": true
  }
}
```

Sandbox restricts only terminal/shell access. It does NOT prevent filesystem writes.

## Manual omo tool and permission examples

The plugin registers the `antigravity-task` tool. You can manually configure omo policies to control its usage. These are user-managed examples; the plugin never auto-writes permission policies.

### Allow the tool unconditionally

```jsonc
// opencode.json
{
  "permission": {
    "tools": {
      "antigravity-task": "allow"
    }
  }
}
```

### Deny the tool

```jsonc
// opencode.json
{
  "permission": {
    "tools": {
      "antigravity-task": "deny"
    }
  }
}
```

### Ask for confirmation before each invocation

```jsonc
// opencode.json
{
  "permission": {
    "tools": {
      "antigravity-task": "ask"
    }
  }
}
```

### Conditional permission based on arguments

You can also set permissions based on tool arguments (requires omo policy engine support):

```jsonc
// Example: allow only plan mode
{
  "permission": {
    "tools": {
      "antigravity-task": {
        "allow": {
          "mode": "plan"
        }
      }
    }
  }
}
```

These examples demonstrate the permission surface. Consult the omo documentation for advanced policy configurations.

## Execute vs plan mode

**Default `mode=execute` maps to `--mode accept-edits` and MAY modify files in the current workspace.** This is the default because most standalone tasks benefit from direct file edits.

`mode=plan` requests planning without applying edits, but does not guarantee filesystem immutability. The agy CLI may still read files and produce output that references workspace state.

The smoke harness (`test:live`) always uses `mode=plan` despite the tool default being `execute`, to avoid any risk of workspace modification during testing.

## Sandbox

`sandbox: true` restricts only terminal/shell access. It does NOT prevent filesystem writes. The agy process can still read and write files in the workspace; sandbox only limits which shell commands are available.

Do not rely on sandbox for filesystem isolation. If you need read-only workspace access, use `mode=plan` and review the output before applying changes manually.

## AGY_PATH

The plugin resolves the agy executable in this order:

1. Explicit `injected` path (test harness only)
2. `AGY_PATH` environment variable
3. `PATH` search for `agy`

If `AGY_PATH` is set to a nonexistent path, the tool returns an actionable error:

```
agy executable does not exist: /path/you/set
```

If agy is not found on PATH and `AGY_PATH` is unset:

```
agy executable was not found (checked AGY_PATH and PATH)
```

Set `AGY_PATH` to the absolute path of your agy binary if it is not on PATH:

```bash
export AGY_PATH=/usr/local/bin/agy
```

## Calls and quota

Each tool invocation spawns one agy process. The agy CLI consumes tokens from your Antigravity account. Monitor usage via the `usage` field in the tool response metadata.

The plugin does not cache, batch, or deduplicate calls. Each `antigravity-task` invocation is independent.

## Continuation exclusivity

`conversationId` and `continueConversation` are mutually exclusive. Setting both returns:

```
conversationId and continueConversation are mutually exclusive
```

Use `conversationId` to resume a specific session. Use `continueConversation` to resume the most recent session without knowing its id.

## Compliance

This plugin delegates to the official Antigravity agy CLI. Your use of agy is subject to Antigravity's [Terms of Service](https://antigravity.google/terms) and [Privacy Policy](https://antigravity.google/privacy).

This plugin does not modify, intercept, or store your Antigravity credentials. Authentication is handled entirely by the agy CLI.

Do not share, piggyback, or reuse OAuth tokens, API keys, or session credentials across users or environments. Each user must authenticate independently through the official agy CLI flow.

This project makes no legal guarantees, endorsements, or assumptions about ToS compliance. Review Antigravity's terms yourself and determine whether your use case is permitted.

## Troubleshooting

### agy not found

```
agy executable was not found (checked AGY_PATH and PATH)
```

Install agy or set `AGY_PATH` to the absolute path:

```bash
export AGY_PATH=/path/to/agy
```

Verify the binary is executable:

```bash
ls -l $AGY_PATH
```

### Authentication errors

The agy CLI handles authentication. If you see auth errors, run agy directly to verify your credentials:

```bash
agy -p "test"
```

Re-authenticate through the official agy flow if needed.

### Model not available

If the specified `model` is not available, agy returns a status error. Omit the `model` argument to use the agy default, or check the [agy documentation](https://antigravity.google/docs/cli/headless) for supported models.

### Timeout

```
agy run (pid 12345) exceeded the host timeout and was terminated
```

Increase `timeoutSeconds` (max 900). The host timeout is `timeoutSeconds * 1000 + 5000ms` grace. If agy's own `--print-timeout` fires first, the tool returns the agy error; if the host watchdog fires first, the tool returns a timeout error.

### Empty output

```
agy returned an empty response
```

The agy CLI returned SUCCESS but with an empty `response` field. This can happen if the task prompt is too vague or if agy's response parsing fails. Try a more specific task prompt.

### Status errors

Non-SUCCESS statuses (ERROR, CANCELED, INTERRUPTED, INVALID, WAITING, RUNNING) return a failure metadata with the status and error detail. Check the agy CLI documentation for status semantics.

## Verification

### Run the test suite

```bash
bun test              # Unit + integration tests
bun run typecheck     # TypeScript strict mode
bun run build         # Build to dist/
```

### Run the isolated integration harness

```bash
bun run test:integration
```

This harness proves the packed loader-safe entry imports and instantiates correctly under OpenCode's real plugin loader, with zero user/project config bleed.

### Run the opt-in live smoke

```bash
ANTIGRAVITY_SMOKE=1 bun run test:live
```

The live smoke is gated by `ANTIGRAVITY_SMOKE=1`. Without this exact value, the script skips with exit 0. CI never sets this flag.

When enabled, the smoke:
- Resolves agy via `AGY_PATH` or PATH
- Spawns with `mode=plan` and a PONG-only prompt in an isolated temp cwd
- Parses the official NDJSON stream
- Validates SUCCESS + conversation id + nonzero usage + PONG in response
- Writes sanitized evidence to `.omo/evidence/task-7-live-smoke-ndjson.txt`

### Inspect the packed artifact

```bash
npm pack --dry-run --json
```

The packed artifact includes `dist/`, `README.md`, `LICENSE`, and `package.json`. Tests, evidence, and credentials are excluded.

## CI and live smoke

CI runs deterministic gates only: unit tests, typecheck, build, integration harness, pack inspection, credential scan, and static scan. CI does not run the live smoke (`test:live`) because it consumes agy quota and requires a valid agy installation.

The live smoke is opt-in for local development and manual verification only.

## Official documentation

- [Antigravity agy headless CLI](https://antigravity.google/docs/cli/headless)
- [Antigravity Terms of Service](https://antigravity.google/terms)
- [OpenCode plugin configuration](https://opencode.ai/config.json)

## License

MIT
