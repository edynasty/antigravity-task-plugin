/**
 * Typed HTTP error for the OpenAI-compatible gateway surface: every failure
 * that reaches a client is an OpenAI-shaped `{error:{message,type,code}}`
 * payload with a stable machine code. Status codes: 400 invalid request,
 * 401 auth, 404 route, 429 queue full, 500 upstream, 504 host timeout.
 */
export class GatewayHttpError extends Error {
  readonly status: number;
  readonly code: string | number;
  readonly type: string;

  constructor(status: number, code: string | number, type: string, message: string) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}
