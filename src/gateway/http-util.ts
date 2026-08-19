/**
 * Shared node:http plumbing for the gateway: bounded request body reading,
 * JSON responses, the OpenAI error envelope and timing-safe bearer auth.
 * Pure adapter: no process, network or filesystem access beyond the server's
 * own request/response objects.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayHttpError } from "./errors.js";

export const MAX_REQUEST_BODY_BYTES = 10_000_000;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

export function sendJsonError(res: ServerResponse, error: GatewayHttpError): void {
  sendJson(res, error.status, { error: { message: error.message, type: error.type, code: error.code } });
}

export function readRequestBody(req: IncomingMessage, maxBytes = MAX_REQUEST_BODY_BYTES): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cleanup();
        rejectPromise(new GatewayHttpError(400, "invalid_request", "invalid_request_error", `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolvePromise(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (): void => {
      cleanup();
      rejectPromise(new GatewayHttpError(400, "invalid_request", "invalid_request_error", "request body could not be read"));
    };
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function bearerValue(header: string): string | null {
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return null;
  }
  const token = header.slice(prefix.length).trim();
  return token === "" ? null : token;
}

export function authorizationMatches(req: IncomingMessage, expected: string | null): boolean {
  if (expected === null) {
    return true;
  }
  const header = req.headers["authorization"];
  if (typeof header !== "string") {
    return false;
  }
  const token = bearerValue(header);
  if (token === null) {
    return false;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
