/**
 * Executable discovery for the agy headless CLI (Todo 4, split from
 * src/process.ts to keep each file under 250 pure LOC; re-exported by
 * src/process.ts so Todo 5 imports one module).
 *
 * Contract: explicit injected path, then AGY_PATH, then the PATH search,
 * each resolved once before spawn. A candidate containing a path separator
 * (or a Windows drive letter) is treated as a filesystem path and must exist
 * and be executable; a bare command name is searched on PATH using the
 * platform separator and, on POSIX, executable permission bits. PATH entries
 * are never shell-interpolated; the resolved string is passed to spawn as
 * argv[0].
 */
import { statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { ResolveError } from "./process-types.js";

const AGY_PATH_ENV = "AGY_PATH";

export interface DiscoveryOptions {
  readonly injected?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly path?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

type ExecState = "ok" | "not-found" | "not-executable";

function execState(candidate: string, platform: NodeJS.Platform): ExecState {
  let stat: Stats | null = null;
  try {
    stat = statSync(candidate);
  } catch {
    stat = null;
  }
  if (stat === null) {
    return "not-found";
  }
  if (!stat.isFile()) {
    return "not-executable";
  }
  if (platform === "win32" || (stat.mode & 0o111) !== 0) {
    return "ok";
  }
  return "not-executable";
}

function pathSeparator(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function looksLikePath(candidate: string, platform: NodeJS.Platform): boolean {
  if (candidate.includes("/") || candidate.includes("\\")) {
    return true;
  }
  return platform === "win32" && candidate.length >= 2 && candidate[1] === ":";
}

function splitPath(raw: string | undefined, separator: string): readonly string[] {
  if (raw === undefined || raw === "") {
    return [];
  }
  return raw.split(separator);
}

function searchPath(command: string, entries: readonly string[], platform: NodeJS.Platform): string | "not-found" {
  for (const entry of entries) {
    if (entry === "") {
      continue;
    }
    if (platform === "win32") {
      const base = join(entry, command);
      const candidates = command.includes(".") ? [base] : [base, `${base}.exe`, `${base}.cmd`, `${base}.bat`, `${base}.com`];
      for (const candidate of candidates) {
        if (execState(candidate, platform) === "ok") {
          return candidate;
        }
      }
      continue;
    }
    const candidate = join(entry, command);
    if (execState(candidate, platform) === "ok") {
      return candidate;
    }
  }
  return "not-found";
}

function resolveCandidate(candidate: string, platform: NodeJS.Platform, options: DiscoveryOptions): string {
  if (candidate.trim() === "") {
    throw new ResolveError("empty-path", "agy executable path must not be empty", candidate);
  }
  const entries = options.path ?? splitPath(options.env["PATH"], pathSeparator(platform));
  if (looksLikePath(candidate, platform)) {
    const state = execState(candidate, platform);
    if (state === "not-found") {
      throw new ResolveError("not-found", `agy executable does not exist: ${candidate}`, candidate);
    }
    if (state === "not-executable") {
      throw new ResolveError("not-executable", `agy executable exists but is not executable: ${candidate}`, candidate);
    }
    return candidate;
  }
  const found = searchPath(candidate, entries, platform);
  if (found === "not-found") {
    throw new ResolveError("not-found", `agy command ${candidate} was not found on PATH`, candidate);
  }
  return found;
}

export function resolveAgy(options: DiscoveryOptions): string {
  const platform = options.platform ?? process.platform;
  if (options.injected !== undefined) {
    return resolveCandidate(options.injected, platform, options);
  }
  const envPath = options.env[AGY_PATH_ENV];
  if (envPath !== undefined) {
    return resolveCandidate(envPath, platform, options);
  }
  const entries = options.path ?? splitPath(options.env["PATH"], pathSeparator(platform));
  const found = searchPath("agy", entries, platform);
  if (found === "not-found") {
    throw new ResolveError("not-found", "agy executable was not found on PATH (checked AGY_PATH and PATH)");
  }
  return found;
}
