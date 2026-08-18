#!/usr/bin/env node
/**
 * agy-gateway CLI entrypoint (package.json `bin`): starts the OpenAI-
 * compatible gateway server, prints the listening address, and shuts down
 * gracefully on SIGINT/SIGTERM. The gateway only spawns the local agy CLI;
 * it never contacts any remote API.
 */
import { defaultGatewayDeps } from "./deps.js";
import { createGatewayServer, gatewayConfigFromEnv } from "./server.js";

const config = gatewayConfigFromEnv(process.env);
const server = createGatewayServer(defaultGatewayDeps, config);

server.on("error", (error) => {
  console.error(`agy-gateway: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`agy-gateway listening on http://${config.host}:${String(config.port)}`);
});

function shutdown(signal: string): void {
  console.log(`agy-gateway: ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
