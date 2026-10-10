import { keccak256, numberToHex, type Address } from "viem";
import type { RpcClient, TransactionEvidence } from "../collection/types.js";
import {
  hex,
  object,
  quantity,
  validateBlock,
} from "../collection/validation.js";
import type { ContractMetadata } from "../metadata/types.js";
import { RpcFailure } from "../collection/rpc.js";

export type Binding =
  "block-code-match" | "code-mismatch" | "code-change" | "unavailable";

export class HistoricalCodeMatcher {
  constructor(private readonly rpc: RpcClient) {}

  async validateChain(evidence: TransactionEvidence): Promise<void> {
    if (
      quantity(
        await this.rpc.request({ method: "eth_chainId" }),
        "chain ID",
      ) !== BigInt(evidence.identity.chainId)
    )
      throw new Error("Wrong decoding chain.");
    await this.validateBlock(evidence);
  }

  async validateBlock(evidence: TransactionEvidence): Promise<void> {
    const block = await this.rpc.request({
      method: "eth_getBlockByNumber",
      params: [numberToHex(evidence.identity.blockNumber), false],
    });
    validateBlock(object(block, "canonical block"), evidence.identity);
  }

  async match(
    evidence: TransactionEvidence,
    target: Address,
    metadata: ContractMetadata,
  ): Promise<Binding> {
    if (
      metadata.identity.chainId !== evidence.identity.chainId ||
      metadata.identity.address.toLowerCase() !== target ||
      !metadata.runtimeMatch ||
      !metadata.runtimeCodeHash
    )
      return "unavailable";
    if (evidence.identity.blockNumber === 0) return "unavailable";
    if (
      metadata.deployment.blockNumber !== null &&
      BigInt(metadata.deployment.blockNumber) >
        BigInt(evidence.identity.blockNumber)
    )
      return "unavailable";
    if (
      evidence.calls.some(
        (call) =>
          ((call.type === "CREATE" || call.type === "CREATE2") &&
            call.to === target) ||
          (call.type === "SELFDESTRUCT" && call.from === target),
      )
    )
      return "code-change";
    if (evidence.stateDiff.status === "collected") {
      const change = Object.entries(evidence.stateDiff.value).find(
        ([key]) => key.toLowerCase() === target,
      )?.[1];
      if (change && object(change, "state account").code !== "=")
        return "code-change";
    }
    try {
      const codes = await Promise.all(
        [evidence.identity.blockNumber - 1, evidence.identity.blockNumber].map(
          (block) =>
            this.rpc.request({
              method: "eth_getCode",
              params: [target, numberToHex(block)],
            }),
        ),
      );
      const hashes = codes.map((code) =>
        keccak256(hex(code, "historical code")),
      );
      if (
        codes.some((code) => code === "0x") ||
        hashes.some((hash) => hash !== metadata.runtimeCodeHash)
      )
        return "code-mismatch";
      return "block-code-match";
    } catch (error) {
      if (!(error instanceof RpcFailure)) throw error;
      return "unavailable";
    }
  }
}
