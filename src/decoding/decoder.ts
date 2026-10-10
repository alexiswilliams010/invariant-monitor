import type { Address } from "viem";
import type { CallFrame, TransactionEvidence } from "../collection/types.js";
import type { ContractMetadata, MetadataResult } from "../metadata/types.js";
import { AbiDecoder, decodeValues } from "./abi.js";
import type { Binding } from "./binding.js";
import {
  AddressNames,
  displayArguments,
  displayText,
  type DisplayArgument,
} from "./presentation.js";

export interface DisplayCall {
  readonly id: string;
  readonly parentId: string | null;
  readonly from: string;
  readonly to: string;
  readonly storageContext: string | null;
  readonly kind: CallFrame["type"];
  readonly action: string;
  readonly args: readonly DisplayArgument[];
  readonly returns: readonly DisplayArgument[];
  readonly valueWei: string;
  readonly reverted: boolean;
  readonly readOnly: boolean;
}

export interface ExecutionDisplay {
  readonly schemaVersion: 1;
  readonly chain: string;
  readonly calls: readonly DisplayCall[];
}

export interface MetadataLookup {
  resolve(identity: {
    chainId: number;
    address: Address;
  }): Promise<MetadataResult>;
}

export interface CodeMatcher {
  validateChain(evidence: TransactionEvidence): Promise<void>;
  validateBlock(evidence: TransactionEvidence): Promise<void>;
  match(
    evidence: TransactionEvidence,
    target: Address,
    metadata: ContractMetadata,
  ): Promise<Binding>;
}

export class TransactionDecoder {
  constructor(
    private readonly metadata: MetadataLookup,
    private readonly code: CodeMatcher,
  ) {}

  async decode(evidence: TransactionEvidence) {
    await this.code.validateChain(evidence);
    const bindings: {
      address: Address;
      metadata: MetadataResult["status"];
      binding: Binding;
      matchId?: string;
      runtimeCodeHash?: string | null;
    }[] = [];
    const resolved = new Map<Address, ContractMetadata>();
    const targets = new Set(
      evidence.calls
        .filter(
          (call) => !["CREATE", "CREATE2", "SELFDESTRUCT"].includes(call.type),
        )
        .map((call) => call.to)
        .filter((address): address is Address => address !== null),
    );
    for (const target of targets) {
      const result = await this.metadata.resolve({
        chainId: evidence.identity.chainId,
        address: target,
      });
      const binding =
        result.status === "found"
          ? await this.code.match(evidence, target, result.metadata)
          : "unavailable";
      bindings.push({
        address: target,
        metadata: result.status,
        binding,
        ...(result.status === "found"
          ? {
              matchId: result.metadata.matchId,
              runtimeCodeHash: result.metadata.runtimeCodeHash,
            }
          : {}),
      });
      if (result.status === "found" && binding === "block-code-match")
        resolved.set(target, result.metadata);
    }
    const names = new AddressNames();
    for (const [target, metadata] of resolved)
      if (metadata.compilation.name)
        names.register(target, metadata.compilation.name);
    for (const call of evidence.calls)
      if ((call.type === "CREATE" || call.type === "CREATE2") && call.to)
        names.register(call.to, null, true);
    for (const call of evidence.calls) {
      names.register(call.from);
      if (call.to) names.register(call.to);
      if (call.storageContext) names.register(call.storageContext);
    }
    const abis = new Map(
      [...resolved]
        .filter(([, metadata]) => metadata.abi !== null)
        .map(([target, metadata]) => [target, new AbiDecoder(metadata.abi!)]),
    );
    const decoding: {
      callId: string;
      status: "decoded" | "arguments-unknown" | "unknown";
      signature?: string;
      returnsDecoded: boolean;
    }[] = [];
    const calls = evidence.calls.map((call): DisplayCall => {
      const isCall = !["CREATE", "CREATE2", "SELFDESTRUCT"].includes(call.type);
      const decoded =
        isCall && call.to ? abis.get(call.to)?.decode(call.input) : null;
      const returns =
        decoded && !call.reverted
          ? decodeValues(decoded.callable.outputs, call.output)
          : null;
      decoding.push({
        callId: call.id,
        status: decoded
          ? decoded.args === null
            ? "arguments-unknown"
            : "decoded"
          : "unknown",
        ...(decoded ? { signature: decoded.callable.signature } : {}),
        returnsDecoded: returns !== null,
      });
      return {
        id: call.id,
        parentId: call.parentId,
        kind: call.type,
        from: names.register(call.from),
        to: call.to ? names.register(call.to) : "contract",
        storageContext: call.storageContext
          ? names.register(call.storageContext)
          : null,
        action: decoded
          ? displayText(decoded.callable.name)
          : isCall
            ? "call"
            : call.type === "SELFDESTRUCT"
              ? "selfdestruct"
              : "create",
        args: decoded
          ? displayArguments(decoded.callable.inputs, decoded.args, names)
          : call.input === "0x"
            ? []
            : [{ name: "", type: "bytes" }],
        returns:
          decoded && !call.reverted
            ? displayArguments(decoded.callable.outputs, returns, names)
            : call.output === "0x"
              ? []
              : [{ name: "", type: "bytes" }],
        valueWei: call.value,
        reverted: call.reverted,
        readOnly: call.readOnly,
      };
    });
    await this.code.validateBlock(evidence);
    const display: ExecutionDisplay = {
      schemaVersion: 1,
      chain: evidence.identity.chain,
      calls,
    };
    return {
      display,
      diagnostics: {
        schemaVersion: 1,
        identity: evidence.identity,
        bindings,
        decoding,
        addresses: names.entries(),
      },
    };
  }
}
