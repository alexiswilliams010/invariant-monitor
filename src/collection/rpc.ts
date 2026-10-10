import {
  createClient,
  http,
  rpcSchema,
  type EIP1193Parameters,
  type EIP1193RequestOptions,
} from "viem";
import type { ChainConfig } from "../config/chains.js";
import type { CollectionRpcSchema, RpcClient } from "./types.js";

export interface RpcMeasurement {
  readonly method: string;
  readonly durationMs: number;
  readonly succeeded: boolean;
}

export class RpcFailure extends Error {
  constructor(
    readonly method: string,
    readonly code?: number,
  ) {
    super(
      `${method} failed${code === undefined ? " (transport or timeout)" : ` (RPC ${code})`}.`,
    );
    this.name = "RpcFailure";
  }
}

export class AlchemyRpcClient implements RpcClient {
  readonly request: RpcClient["request"];
  readonly #measurements: RpcMeasurement[] = [];

  constructor(chain: ChainConfig, url: string, timeoutMs = 30_000) {
    const client = createClient({
      chain,
      rpcSchema: rpcSchema<CollectionRpcSchema>(),
      transport: http(url, {
        retryCount: 0,
        timeout: timeoutMs,
        maxResponseBodySize: 64 * 1024 * 1024,
      }),
    });
    this.request = (async (
      args: EIP1193Parameters<CollectionRpcSchema>,
      options?: EIP1193RequestOptions,
    ) => {
      const start = performance.now();
      let succeeded = false;
      try {
        const result = await client.request(args, options);
        succeeded = true;
        return result;
      } catch (error) {
        // Viem errors contain the authenticated URL; never retain their messages or causes.
        throw new RpcFailure(args.method, rpcCode(error));
      } finally {
        this.#measurements.push({
          method: args.method,
          durationMs: Math.round(performance.now() - start),
          succeeded,
        });
      }
    }) as RpcClient["request"];
  }

  get measurements(): readonly RpcMeasurement[] {
    return [...this.#measurements];
  }
}

function rpcCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if ("code" in error && typeof error.code === "number") return error.code;
    error = error.cause;
  }
  return undefined;
}
