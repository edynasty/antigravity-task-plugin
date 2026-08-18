/**
 * Injectable adapter seam for the gateway, mirroring the runner's RunnerDeps:
 * tests substitute fakes here so no real agy process is ever spawned and no
 * network is ever touched. `cwd` is the agy working directory (AGY_GATEWAY_CWD
 * or the process cwd) — agent-mode agy runs operate relative to it.
 */
import { resolveAgy, runAgy } from "../process.js";
import type { DiscoveryOptions, ProcessResult, SpawnOptions } from "../process.js";

export interface GatewayDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform | undefined;
  readonly cwd: string;
  readonly resolveAgy: (options: DiscoveryOptions) => string;
  readonly runAgy: (options: SpawnOptions) => Promise<ProcessResult>;
}

export const defaultGatewayDeps: GatewayDeps = {
  env: process.env,
  platform: process.platform,
  cwd: process.env["AGY_GATEWAY_CWD"] ?? process.cwd(),
  resolveAgy,
  runAgy,
};
