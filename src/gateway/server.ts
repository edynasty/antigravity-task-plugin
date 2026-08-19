/**
 * OpenAI-compatible gateway server (Todo 13): a standalone node:http server
 * (no new dependencies, no plugins) that proxies /v1/chat/completions and
 * /v1/models to the local agy CLI as a subprocess. The gateway NEVER contacts
 * any remote API — spawning the agy binary is the only execution path. Binding
 * defaults to 127.0.0.1:8787; env knobs:
 *   AGY_GATEWAY_HOST / AGY_GATEWAY_PORT / AGY_GATEWAY_TOKEN (bearer auth)
 *   AGY_GATEWAY_MAX_QUEUE (serial queue depth, default 8)
 *   AGY_GATEWAY_TIMEOUT_S (default --print-timeout seconds, default 300)
 *   AGY_GATEWAY_MODELS_TTL_S (model cache TTL, default 3600)
 *   AGY_GATEWAY_CACHE_DIR (model cache dir, default ~/.agy-gateway)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GatewayDeps } from "./deps.js";
import { GatewayHttpError } from "./errors.js";
import { authorizationMatches, sendJson, sendJsonError } from "./http-util.js";
import { listModels } from "./models.js";
import { handleChat, type RequestMeta } from "./chat.js";
import { SerialQueue } from "./queue.js";
import { boundDiagnosticText } from "../runner-types.js";

export interface GatewayConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string | null;
  readonly maxQueue: number;
  readonly defaultTimeoutSeconds: number;
  readonly modelsTtlSeconds: number;
  readonly cacheDir: string;
  readonly maxBodyBytes: number;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalToken(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function gatewayConfigFromEnv(env: Readonly<Record<string, string | undefined>>): GatewayConfig {
  return {
    host: env["AGY_GATEWAY_HOST"] ?? "127.0.0.1",
    port: parsePort(env["AGY_GATEWAY_PORT"], 8787),
    token: parseOptionalToken(env["AGY_GATEWAY_TOKEN"]),
    maxQueue: parsePositiveInt(env["AGY_GATEWAY_MAX_QUEUE"], 8),
    defaultTimeoutSeconds: parsePositiveInt(env["AGY_GATEWAY_TIMEOUT_S"], 300),
    modelsTtlSeconds: parsePositiveInt(env["AGY_GATEWAY_MODELS_TTL_S"], 3600),
    cacheDir: env["AGY_GATEWAY_CACHE_DIR"] ?? join(homedir(), ".agy-gateway"),
    maxBodyBytes: parsePositiveInt(env["AGY_GATEWAY_MAX_BODY_BYTES"], 10_000_000),
  };
}

function pathOf(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const index = raw.indexOf("?");
  return index === -1 ? raw : raw.slice(0, index);
}

function unexpectedError(error: unknown, cwd: string): GatewayHttpError {
  if (error instanceof GatewayHttpError) {
    return error;
  }
  const message = error instanceof Error ? boundDiagnosticText(error.message, cwd) : "unexpected gateway failure";
  return new GatewayHttpError(500, "upstream_error", "server_error", message);
}

function modelsRoute(res: ServerResponse, deps: GatewayDeps, config: GatewayConfig): void {
  listModels(deps, { ttlSeconds: config.modelsTtlSeconds, cacheDir: config.cacheDir })
    .then((models) => {
      sendJson(res, 200, {
        object: "list",
        data: models.map((model) => ({ id: model, object: "model", owned_by: "agy" })),
      });
    })
    .catch((error: unknown) => {
      const httpError = unexpectedError(error, deps.cwd);
      sendJsonError(res, httpError);
    });
}

export function createGatewayServer(deps: GatewayDeps, config: GatewayConfig): Server {
  const queue = new SerialQueue(config.maxQueue);
  return createServer((req, res) => {
    const meta: RequestMeta = { status: 200, model: null, errorMessage: null, promptBytes: null };
    const pathname = pathOf(req);
    const started = Date.now();
    res.on("finish", () => {
      const parts = [`[agy-gateway] ${req.method ?? "?"} ${pathname} ${meta.status} ${Date.now() - started}ms`];
      if (meta.model !== null) {
        parts.push(`model=${meta.model}`);
      }
      if (meta.promptBytes !== null) {
        parts.push(`promptBytes=${meta.promptBytes}`);
      }
      if (meta.errorMessage !== null) {
        parts.push(`error=${meta.errorMessage}`);
      }
      console.log(parts.join(" "));
    });
    if (pathname === "/v1" || pathname === "/") {
      if (req.method === "GET") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
    }
    if (!authorizationMatches(req, config.token)) {
      meta.status = 401;
      sendJsonError(res, new GatewayHttpError(401, "invalid_api_key", "authentication_error", "invalid bearer token"));
      return;
    }
    const route = `${req.method ?? ""} ${pathname}`;
    const guard = (task: Promise<void>): void => {
      task.catch((error: unknown) => {
        const httpError = unexpectedError(error, deps.cwd);
        meta.status = httpError.status;
        meta.errorMessage = httpError.message;
        if (!res.writableEnded) {
          try {
            sendJsonError(res, httpError);
          } catch {
            // The socket may already be gone; the response is best-effort here.
          }
        }
      });
    };
    switch (route) {
      case "POST /v1/chat/completions":
        guard(handleChat(req, res, { deps, queue, defaultTimeoutSeconds: config.defaultTimeoutSeconds, maxBodyBytes: config.maxBodyBytes, log: console.log, meta }));
        return;
      case "GET /v1/models":
        modelsRoute(res, deps, config);
        return;
      default: {
        meta.status = 404;
        sendJsonError(
          res,
          new GatewayHttpError(404, "not_found", "not_found_error", `no such endpoint: ${req.method ?? ""} ${pathname}`),
        );
        return;
      }
    }
  });
}
