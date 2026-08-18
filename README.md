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

## OpenAI-compatible gateway (agy-gateway)

The package ships an optional standalone HTTP gateway (`agy-gateway` bin) that exposes an
OpenAI-compatible surface — `POST /v1/chat/completions` and `GET /v1/models` — over the local
agy CLI. Tools such as omo/OpenCode can then select agy's models as if they were a normal LLM
provider, including live streaming text.

**Execution constraint: the gateway NEVER contacts any API directly. There are zero network
calls to Google/Gemini/Antigravity endpoints. The only execution path is spawning the local
agy CLI binary as a subprocess and talking to it over its stdio NDJSON protocol.** Direct API
access is known to cause account bans; the archived agy-tools-rust repository is the
counterexample that motivated this design.

### Run

```bash
npm run build
AGY_GATEWAY_HOST=127.0.0.1 AGY_GATEWAY_PORT=8787 node dist/gateway/cli.js
```

| Env var | Default | Meaning |
|---|---|---|
| `AGY_GATEWAY_HOST` / `AGY_GATEWAY_PORT` | `127.0.0.1` / `8787` | Bind address |
| `AGY_GATEWAY_TOKEN` | (none) | When set, require `Authorization: Bearer <token>` (401 otherwise) |
| `AGY_GATEWAY_MAX_QUEUE` | `8` | Max requests waiting in the serial FIFO queue; overflow → 429 `queue full` |
| `AGY_GATEWAY_TIMEOUT_S` | `300` | Default `--print-timeout` seconds; the host watchdog adds a 5s grace |
| `AGY_GATEWAY_MODELS_TTL_S` | `3600` | `agy models` cache TTL |
| `AGY_GATEWAY_CACHE_DIR` | `~/.agy-gateway` | Model cache directory |
| `AGY_GATEWAY_CWD` | process cwd | agy's working directory (agent-mode runs operate relative to it) |

**Serial queue**: at most ONE agy task runs at a time (ban avoidance). Concurrent requests wait
FIFO; a client disconnect removes its queued job.

### Configure omo / OpenCode

Start the gateway first, then add it as an OpenAI-compatible provider. With the gateway running
on the default address, this config is copy-paste ready:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "agy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antigravity (agy CLI gateway)",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "dummy"
      },
      "models": {
        "gemini-3.7-flash-high": { "name": "Gemini 3.7 Flash (High)" },
        "gemini-3.5-flash-medium": { "name": "Gemini 3.5 Flash (Medium)" },
        "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6 (Thinking)" },
        "claude-opus-4-6": { "name": "Claude Opus 4.6 (Thinking)" },
        "gpt-oss-120b": { "name": "GPT-OSS-120b" }
      }
    }
  }
}
```

The model list above is the builtin fallback; run `curl http://127.0.0.1:8787/v1/models` against a
live gateway for the full list from your agy installation and add any entries you want to select.
The `apiKey` is ignored unless `AGY_GATEWAY_TOKEN` is set — when it is, use that token here. If
your OpenCode is configured with an `auth` requirement for the provider, prefer the token-based
setup above. Restart OpenCode after editing the config.

### Request → prompt framing

OpenAI `messages` (roles `system` / `user` / `assistant`, string content) are converted into a
single role-labeled task prompt passed to agy as `-p`:

```text
<system>
<system content verbatim>
</system>

<user>
<user content verbatim>
</user>

<assistant>
<assistant content verbatim>
</assistant>
```

Unknown roles, non-string content, an empty `messages` array and an empty `model` are rejected
with 400. `temperature` and unknown fields are ignored. `max_tokens` (positive integer) maps to a
hard response cap of ~4 UTF-16 code units per token. Request `mode: "plan"` maps to the agy
`--mode plan` CLI flag (never injected into the prompt text); the default is `execute`
(`--mode accept-edits` — agy may modify files and run commands). `timeoutSeconds` maps to
`--print-timeout <n>s` plus a host watchdog; expiry → 504.

### Responses

`stream=true` (default): SSE chunks shaped as OpenAI `chat.completion.chunk` objects, one per
agy `step_update.text_delta`, then a `finish_reason:"stop"` chunk, an optional
`data: {"conversation_id":"..."}` line, and `data: [DONE]`. Streaming headers are written when
the agy run starts, so pre-run failures (auth, validation, queue full, upstream 500) come back
as normal JSON errors.

`stream=false`: a full `chat.completion` object with `usage` (from the agy result) and
`conversation_id`.

### Conversation continuation

Pass the non-standard body field `conversationId` or the `x-agy-conversation` header to resume a
conversation (`--conversation <id>`). The resulting id is surfaced via the trailing SSE
`conversation_id` line (stream) or the `conversation_id` field (non-stream).

### Models

`GET /v1/models` spawns the local `agy models` subprocess (a subprocess, not a network call),
parses one model per line (first token = id), and caches the result in
`AGY_GATEWAY_CACHE_DIR/models.json`. Fallback chain: fresh cache → stale cache → builtin defaults
(`gemini-3.7-flash-high`, `gemini-3.5-flash-medium`, `claude-sonnet-4-6`, `claude-opus-4-6`,
`gpt-oss-120b`).

### Out of scope (documented, not implemented)

Interactive permission flows, model name mapping/aliasing, OpenAI `tool_calls` mapping, multi-user
auth, and array-of-parts message content. The request `model` is passed verbatim to `--model`;
agy validates it, and an invalid model surfaces as a 500 with the (credential-redacted) agy
detail.

### Docker deployment

The gateway can be deployed as a container. The `Dockerfile` is multi-stage on
`node:22-slim`: a build stage runs `npm install` (the repo has no
`package-lock.json` — only `bun.lock` — so plain `npm install` is used) and
`npm run build`, and a lean runtime stage installs the official agy CLI
(`curl -fsSL https://antigravity.google/cli/install.sh | bash`, installed to
`/root/.local/bin/agy`) and runs only the compiled `dist/`. No node_modules, no
devDependencies, and no credentials are baked into the image.

#### Build and run (plain docker)

```bash
docker build -t agy-gateway .
docker run -d --name agy-gateway -p 8787:8787 agy-gateway
curl -s http://127.0.0.1:8787/v1          # → 200 {"status":"ok"}
curl -s http://127.0.0.1:8787/v1/models   # → 200 {"object":"list","data":[...]}
```

The image sets `AGY_GATEWAY_HOST=0.0.0.0` because the gateway's default bind
address is `127.0.0.1`, which would be unreachable from the host once the port
is published with `-p 8787:8787`. A `HEALTHCHECK` probes `GET /v1` using Node's
built-in fetch (`node:22-slim` has no `curl`). agy agent-mode runs operate in
`/workspace` (`AGY_GATEWAY_CWD`), so bind-mount a directory there if you want
agy's file edits to land on the host.

#### Authentication inside the container (Gemini API key)

agy normally authenticates via the OS keyring (macOS Keychain / Linux Secret
Service). A container has **no keyring**, so interactive `agy login` is not
possible. The official supported headless path — see
[Using a Gemini API key](https://antigravity.google/docs/cli/install/) — is to
set `"modelProvider": "gemini"` in `settings.json` and pass `GEMINI_API_KEY`:

```bash
mkdir -p agy-config/antigravity-cli
echo '{"modelProvider":"gemini"}' > agy-config/antigravity-cli/settings.json
```

The gateway still **never calls any API directly**: agy runs as a local
subprocess inside the container and talks to the gateway over its stdio NDJSON
protocol, exactly as on the host. Direct-API approaches are known to cause
account bans.

#### docker-compose

Create a `.env` next to `docker-compose.yml`:

```bash
# Required: agy headless auth (modelProvider: "gemini", see above).
GEMINI_API_KEY=your-gemini-api-key-here
# Optional: require Authorization: Bearer <token> on the gateway.
#AGY_GATEWAY_TOKEN=change-me
```

`docker compose up` fails loudly with `set GEMINI_API_KEY in .env` if the key
is missing. Then:

```bash
# One-time bootstrap (also shown above): enable the Gemini API key provider.
mkdir -p agy-config/antigravity-cli
echo '{"modelProvider":"gemini"}' > agy-config/antigravity-cli/settings.json

docker compose up -d --build
curl -s http://127.0.0.1:8787/v1/models
```

What compose mounts:

- `./agy-config` → `/root/.gemini` — agy's `settings.json` and caches; a bind
  mount so you can edit the settings file directly from the host.
- `${PWD:-.}/workspace` → `/workspace` — agy's working directory; **agy agent
  mode (`accept-edits`) may create or modify files here**, review it like any
  other workspace.

If the container is exposed beyond localhost, set `AGY_GATEWAY_TOKEN` (and the
matching `Authorization: Bearer` header in your client) — without a token the
gateway is unauthenticated on its published port.

## Official documentation

- [Antigravity agy headless CLI](https://antigravity.google/docs/cli/headless)
- [Antigravity Terms of Service](https://antigravity.google/terms)
- [OpenCode plugin configuration](https://opencode.ai/config.json)

## License

MIT
