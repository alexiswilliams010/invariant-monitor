import {
  decodeEventLog,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  hexToBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { CallFrame, RpcClient } from "../collection/types.js";
import type {
  InterpretationAdapter,
  InterpretationResult,
  InterpretationContext,
} from "./types.js";
import { displayText } from "../decoding/presentation.js";

export interface TokenMetadata {
  readonly symbol?: string;
  readonly decimals?: number;
}
export interface TokenMetadataReader {
  read(address: Address): Promise<TokenMetadata>;
}
export interface TokenMovement {
  readonly asset: Address;
  readonly from: Address | null;
  readonly to: Address | null;
  readonly amount: string;
  readonly logIndex: number;
  readonly candidateCallId?: string;
}
export interface TokenInterpretation extends InterpretationResult {
  readonly movements: readonly TokenMovement[];
  readonly metadata: ReadonlyMap<Address, TokenMetadata>;
  readonly hiddenReadIds: readonly string[];
}

export class RpcTokenMetadataReader implements TokenMetadataReader {
  constructor(
    private readonly rpc: RpcClient,
    private readonly block: Hex,
  ) {}
  async read(address: Address): Promise<TokenMetadata> {
    const read = async (name: "symbol" | "decimals") => {
      try {
        const output = await this.rpc.request({
          method: "eth_call",
          params: [
            {
              to: address,
              data: encodeFunctionData({ abi: erc20Abi, functionName: name }),
            },
            this.block,
          ],
        });
        if (name === "symbol" && /^0x[0-9a-f]{64}$/i.test(output)) {
          const bytes = hexToBytes(output);
          const end = bytes.findIndex((byte) => byte === 0);
          return new TextDecoder("utf-8", { fatal: true }).decode(
            end < 0 ? bytes : bytes.slice(0, end),
          );
        }
        return decodeFunctionResult({
          abi: erc20Abi,
          functionName: name,
          data: output,
        });
      } catch {
        return undefined;
      }
    };
    const [symbol, decimals] = await Promise.all([
      read("symbol"),
      read("decimals"),
    ]);
    return {
      ...(typeof symbol === "string" && symbol.trim()
        ? { symbol: displayText(symbol).slice(0, 40) }
        : {}),
      ...(typeof decimals === "number" ? { decimals } : {}),
    };
  }
}

export function forwardingFrames(
  frame: CallFrame,
  calls: readonly CallFrame[],
): readonly CallFrame[] | null {
  const frames = [frame];
  let current = frame;
  for (;;) {
    const children = calls.filter((call) => call.parentId === current.id);
    if (!children.length) return frames;
    const child = children[0]!;
    if (
      children.length !== 1 ||
      child.type !== "DELEGATECALL" ||
      child.storageContext !== frame.to ||
      child.input !== frame.input ||
      child.reverted
    )
      return null;
    frames.push(child);
    current = child;
  }
}

export class StandardTokenInterpreter implements InterpretationAdapter {
  readonly id = "erc20-transfers";
  readonly scope = { kind: "standard" } as const;
  constructor(private readonly metadataReader?: TokenMetadataReader) {}
  async interpret(
    context: InterpretationContext,
  ): Promise<TokenInterpretation> {
    const movements: TokenMovement[] = [];
    for (const raw of context.evidence.receipt.logs as unknown as {
      address: Address;
      topics: [Hex, ...Hex[]];
      data: Hex;
      logIndex: Hex;
    }[]) {
      if (raw.topics.length !== 3 || !/^0x[0-9a-f]{64}$/i.test(raw.data))
        continue;
      try {
        const event = decodeEventLog({
          abi: erc20Abi,
          eventName: "Transfer",
          data: raw.data,
          topics: raw.topics,
          strict: true,
        });
        const asset = raw.address.toLowerCase() as Address;
        const from = event.args.from.toLowerCase() as Address;
        const to = event.args.to.toLowerCase() as Address;
        const amount = event.args.value.toString();
        const candidates = context.evidence.calls.filter((call) => {
          if (
            call.reverted ||
            call.readOnly ||
            call.type !== "CALL" ||
            call.to !== asset ||
            !forwardingFrames(call, context.evidence.calls)
          )
            return false;
          if (
            call.output !== "0x" &&
            call.output !==
              encodeFunctionResult({
                abi: erc20Abi,
                functionName: "transfer",
                result: true,
              })
          )
            return false;
          try {
            const decoded = decodeFunctionData({
              abi: erc20Abi,
              data: call.input,
            });
            if (decoded.functionName === "transfer")
              return (
                call.from === from &&
                decoded.args[0].toLowerCase() === to &&
                decoded.args[1].toString() === amount &&
                encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "transfer",
                  args: decoded.args,
                }) === call.input
              );
            if (decoded.functionName === "transferFrom")
              return (
                decoded.args[0].toLowerCase() === from &&
                decoded.args[1].toLowerCase() === to &&
                decoded.args[2].toString() === amount &&
                encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "transferFrom",
                  args: decoded.args,
                }) === call.input
              );
          } catch {
            /* Non-standard calldata stays in the call diagram. */
          }
          return false;
        });
        movements.push({
          asset,
          from: from === zeroAddress ? null : from,
          to: to === zeroAddress ? null : to,
          amount,
          logIndex: Number(BigInt(raw.logIndex)),
          ...(candidates.length === 1
            ? { candidateCallId: candidates[0]!.id }
            : {}),
        });
      } catch {
        /* Other event layouts are not ERC-20 transfers. */
      }
    }
    const uses = new Map<string, number>();
    for (const movement of movements)
      if (movement.candidateCallId)
        uses.set(
          movement.candidateCallId,
          (uses.get(movement.candidateCallId) ?? 0) + 1,
        );
    const unique = movements.map((movement): TokenMovement => {
      if (!movement.candidateCallId || uses.get(movement.candidateCallId) === 1)
        return movement;
      const { candidateCallId: _, ...rest } = movement;
      return rest;
    });
    const metadata = new Map<Address, TokenMetadata>();
    const hiddenReadIds: string[] = [];
    for (const asset of new Set(movements.map((m) => m.asset))) {
      const observed: TokenMetadata[] = [];
      for (const call of context.evidence.calls) {
        if (
          call.to !== asset ||
          call.reverted ||
          call.value !== "0" ||
          !["CALL", "STATICCALL"].includes(call.type) ||
          !forwardingFrames(call, context.evidence.calls)
        )
          continue;
        for (const name of ["symbol", "decimals"] as const) {
          if (
            call.input !==
            encodeFunctionData({ abi: erc20Abi, functionName: name })
          )
            continue;
          try {
            const result = decodeFunctionResult({
              abi: erc20Abi,
              functionName: name,
              data: call.output,
            });
            if (name === "decimals" && typeof result === "number")
              observed.push({ decimals: result });
            if (name === "symbol" && typeof result === "string")
              observed.push({ symbol: displayText(result).slice(0, 40) });
            hiddenReadIds.push(call.id);
          } catch {
            /* Failed metadata reads stay visible. */
          }
        }
      }
      const remote = (await this.metadataReader?.read(asset)) ?? {};
      const decimals = new Set(
        observed.flatMap((m) => (m.decimals === undefined ? [] : [m.decimals])),
      );
      const symbols = new Set(
        observed.flatMap((m) => (m.symbol ? [m.symbol] : [])),
      );
      metadata.set(asset, {
        ...(symbols.size === 1
          ? { symbol: [...symbols][0]! }
          : symbols.size === 0 && remote.symbol
            ? { symbol: remote.symbol }
            : {}),
        ...(decimals.size === 1
          ? { decimals: [...decimals][0]! }
          : decimals.size === 0 && remote.decimals !== undefined
            ? { decimals: remote.decimals }
            : {}),
      });
    }
    return {
      status: "interpreted",
      facts: unique.map((movement) => ({
        kind: "asset-movement",
        asset: { contract: movement.asset, ...metadata.get(movement.asset) },
        from: movement.from,
        to: movement.to,
        amount: movement.amount,
        evidence: {
          basis: "event-reported",
          position: { kind: "transaction" },
          references: [
            { kind: "log", logIndex: movement.logIndex },
            ...(movement.candidateCallId
              ? [{ kind: "call" as const, callId: movement.candidateCallId }]
              : []),
          ],
        },
      })),
      movements: unique,
      metadata,
      hiddenReadIds,
    };
  }
}
