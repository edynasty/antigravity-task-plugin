/**
 * Model listing for the gateway: `agy models` is executed as a LOCAL subprocess
 * (never a network call) whose plain-text output is parsed one model per line
 * (first whitespace token = id), cached under ~/.agy-gateway/models.json with a
 * TTL, and served with a fallback chain: fresh cache -> stale cache -> builtin
 * defaults. Every failure path degrades to a list, never an error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GatewayDeps } from "./deps.js";

export const BUILTIN_MODELS: readonly string[] = [
  "gemini-3.7-flash-high",
  "gemini-3.5-flash-medium",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "gpt-oss-120b",
];

/** Host watchdog for the `agy models` subprocess (ms). */
export const MODELS_FETCH_TIMEOUT_MS = 20_000;

export interface ModelsOptions {
  readonly ttlSeconds: number;
  readonly cacheDir: string;
  readonly builtin?: readonly string[];
}

interface ModelsCache {
  readonly models: readonly string[];
  readonly fetchedAt: number;
}

export function parseModelsOutput(stdout: string): readonly string[] {
  const models: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const first = trimmed.split(/\s+/)[0];
    if (first !== undefined && first !== "") {
      models.push(first);
    }
  }
  return models;
}

function cacheFile(cacheDir: string): string {
  return join(cacheDir, "models.json");
}

function readCache(file: string): ModelsCache | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: unknown; fetchedAt?: unknown };
    if (!Array.isArray(parsed.models)) {
      return null;
    }
    const models = parsed.models.filter((model): model is string => typeof model === "string");
    if (!Number.isFinite(parsed.fetchedAt)) {
      return null;
    }
    return { models, fetchedAt: parsed.fetchedAt as number };
  } catch {
    return null;
  }
}

function writeCache(file: string, models: readonly string[], fetchedAt: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ models, fetchedAt }));
}

export async function listModels(deps: GatewayDeps, options: ModelsOptions): Promise<readonly string[]> {
  const builtin = options.builtin ?? BUILTIN_MODELS;
  const file = cacheFile(options.cacheDir);
  const cached = readCache(file);
  const now = Date.now();
  if (cached !== null && now - cached.fetchedAt < options.ttlSeconds * 1000) {
    return cached.models;
  }
  let executable: string;
  try {
    executable = deps.resolveAgy({ env: deps.env, ...(deps.platform !== undefined ? { platform: deps.platform } : {}) });
  } catch {
    return cached?.models ?? builtin;
  }
  const controller = new AbortController();
  try {
    const result = await deps.runAgy({
      argv: [executable, "models"],
      cwd: deps.cwd,
      env: deps.env,
      signal: controller.signal,
      hostTimeoutMs: MODELS_FETCH_TIMEOUT_MS,
    });
    const models = parseModelsOutput(result.stdoutChunks.join(""));
    if (models.length === 0 || result.exitCode !== 0) {
      return cached?.models ?? builtin;
    }
    writeCache(file, models, now);
    return models;
  } catch {
    return cached?.models ?? builtin;
  }
}
