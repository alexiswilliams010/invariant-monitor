import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
} from "viem";
import type { CallFrame } from "../collection/types.js";
import { forwardingFrames } from "./tokens.js";

export interface ObservedTokenBalance {
  readonly asset: string;
  readonly holder: string;
  readonly amount: string;
  readonly callIds: readonly string[];
  readonly basis: "balanceOf-before-token-writes";
}

export class TokenBalanceReader {
  read(calls: readonly CallFrame[]): ReadonlyMap<string, ObservedTokenBalance> {
    const written = new Set<string>();
    const balances = new Map<string, ObservedTokenBalance>();
    const conflicts = new Set<string>();
    for (const call of calls) {
      const asset = call.to?.toLowerCase();
      if (
        asset &&
        call.type === "STATICCALL" &&
        call.readOnly &&
        !call.reverted &&
        !written.has(asset)
      ) {
        try {
          const decoded = decodeFunctionData({
            abi: erc20Abi,
            data: call.input,
          });
          if (
            decoded.functionName === "balanceOf" &&
            encodeFunctionData({
              abi: erc20Abi,
              functionName: "balanceOf",
              args: decoded.args,
            }).toLowerCase() === call.input.toLowerCase() &&
            /^0x[0-9a-f]{64}$/i.test(call.output) &&
            forwardingFrames(call, calls)
          ) {
            const holder = decoded.args[0].toLowerCase();
            const amount = decodeFunctionResult({
              abi: erc20Abi,
              functionName: "balanceOf",
              data: call.output,
            }).toString();
            const key = balanceKey(asset, holder);
            const previous = balances.get(key);
            if (previous && previous.amount !== amount) conflicts.add(key);
            balances.set(key, {
              asset,
              holder,
              amount,
              callIds: [...(previous?.callIds ?? []), call.id],
              basis: "balanceOf-before-token-writes",
            });
          }
        } catch {
          // Malformed or nonstandard balance reads cannot supply a denominator.
        }
      }
      // Even reverted executions are excluded conservatively; no log-based reconstruction.
      if (!call.readOnly && call.storageContext)
        written.add(call.storageContext.toLowerCase());
    }
    for (const key of conflicts) balances.delete(key);
    return balances;
  }
}

export function balanceKey(asset: string, holder: string): string {
  return `${asset.toLowerCase()}:${holder.toLowerCase()}`;
}

export function balancePercentage(
  net: bigint,
  before: bigint,
): string | undefined {
  if (before < 0n || before + net < 0n || net === 0n) return undefined;
  if (before === 0n) return "new balance";
  const magnitude = net < 0n ? -net : net;
  const hundredths = (magnitude * 10_000n) / before;
  const sign = net < 0n ? "-" : "+";
  if (hundredths === 0n) return `${sign}<0.01%`;
  const fractional = (hundredths % 100n)
    .toString()
    .padStart(2, "0")
    .replace(/0+$/, "");
  const approximate = (magnitude * 10_000n) % before !== 0n ? "~" : "";
  return `${approximate}${sign}${hundredths / 100n}${fractional ? `.${fractional}` : ""}%`;
}
