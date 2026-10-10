import { numberToHex } from "viem";
import { chains } from "../config/chains.js";
import { normalizeCalls } from "./calls.js";
import { RpcFailure } from "./rpc.js";
import type {
  CollectionCache,
  JsonObject,
  RpcClient,
  StateDiffEvidence,
  TransactionCollector,
  TransactionEvidence,
  TransactionRequest,
} from "./types.js";
import {
  hash,
  identityOf,
  object,
  quantity,
  validateBlock,
  validateStateDiff,
} from "./validation.js";

export class AlchemyTransactionCollector implements TransactionCollector {
  cacheHit = false;

  constructor(
    private readonly rpc: RpcClient,
    private readonly cache?: CollectionCache,
  ) {}

  async collect(
    request: TransactionRequest,
    options: { readonly includeStateDiff: boolean },
  ): Promise<TransactionEvidence> {
    this.cacheHit = false;
    request = { ...request, transactionHash: hash(request.transactionHash) };
    const chainId = quantity(
      await this.rpc.request({ method: "eth_chainId" }),
      "RPC chain ID",
    );
    if (chainId !== BigInt(chains[request.chain].id))
      throw new Error("RPC endpoint is connected to the wrong chain.");
    const [transactionResult, receiptResult] = await Promise.all([
      this.rpc.request({
        method: "eth_getTransactionByHash",
        params: [request.transactionHash],
      }),
      this.rpc.request({
        method: "eth_getTransactionReceipt",
        params: [request.transactionHash],
      }),
    ]);
    if (transactionResult === null || receiptResult === null)
      throw new Error("Transaction is missing or not mined.");
    const transaction = object(transactionResult, "transaction");
    const receipt = object(receiptResult, "receipt");
    const identity = identityOf(request, transaction, receipt);
    const fetchBlock = async (): Promise<JsonObject> =>
      object(
        await this.rpc.request({
          method: "eth_getBlockByNumber",
          params: [numberToHex(identity.blockNumber), false],
        }),
        "block",
      );
    const block = await fetchBlock();
    validateBlock(block, identity);

    const cached = await this.cache?.read(identity, options.includeStateDiff);
    let rawTraces: unknown;
    let stateDiff: StateDiffEvidence;
    if (cached !== undefined) {
      const entry = object(cached, "cached collection");
      const cachedIdentity = object(entry.identity, "cached identity");
      if (
        entry.schemaVersion !== 1 ||
        Object.entries(identity).some(
          ([key, value]) => cachedIdentity[key] !== value,
        )
      )
        throw new Error("Cached collection identity mismatch.");
      rawTraces = entry.traces;
      const savedDiff = object(entry.stateDiff, "cached state diff");
      if (options.includeStateDiff) {
        if (savedDiff.status !== "collected")
          throw new Error("Cached state diff is incomplete.");
        stateDiff = {
          status: "collected",
          value: validateStateDiff(savedDiff.value),
        };
      } else {
        if (savedDiff.status !== "not-requested")
          throw new Error("Cached state diff mode mismatch.");
        stateDiff = { status: "not-requested" };
      }
      this.cacheHit = true;
    } else {
      [rawTraces, stateDiff] = await Promise.all([
        this.rpc.request({
          method: "trace_transaction",
          params: [request.transactionHash],
        }),
        options.includeStateDiff
          ? this.fetchStateDiff(request)
          : Promise.resolve({ status: "not-requested" } as const),
      ]);
    }
    const { traces, calls } = normalizeCalls(
      rawTraces,
      identity,
      transaction,
      receipt,
    );
    validateBlock(await fetchBlock(), identity);
    const evidence: TransactionEvidence = {
      schemaVersion: 1,
      identity,
      transaction,
      receipt,
      block,
      traces,
      calls,
      stateDiff,
    };
    if (!this.cacheHit && stateDiff.status !== "unavailable")
      await this.cache?.write(evidence, options.includeStateDiff);
    return evidence;
  }

  private async fetchStateDiff(
    request: TransactionRequest,
  ): Promise<StateDiffEvidence> {
    let response: unknown;
    try {
      response = await this.rpc.request({
        method: "trace_replayTransaction",
        params: [request.transactionHash, ["stateDiff"]],
      });
    } catch (error) {
      if (!(error instanceof RpcFailure)) throw error;
      return { status: "unavailable", reason: error.message };
    }
    const replay = object(response, "replay response");
    if (replay.stateDiff === null)
      return {
        status: "unavailable",
        reason: "Provider returned no state diff.",
      };
    return { status: "collected", value: validateStateDiff(replay.stateDiff) };
  }
}
