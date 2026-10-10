import {
  decodeAbiParameters,
  encodeAbiParameters,
  toHex,
  type AbiParameter,
  type Hex,
} from "viem";
import type { TransactionEvidence } from "../collection/types.js";
import { address, array, hex, object } from "../collection/validation.js";

export interface MappingKey {
  readonly encoded: Hex;
  readonly value: unknown;
  readonly type: string;
}

export class StorageCandidates {
  private readonly words = new Set<Hex>();
  private readonly dynamic = new Map<string, MappingKey[]>();
  private readonly keyCache = new Map<string, readonly MappingKey[]>();
  truncated = false;

  constructor(evidence: TransactionEvidence) {
    const addresses = new Set<string>();
    for (const call of evidence.calls)
      for (const value of [call.from, call.to, call.storageContext])
        if (value) addresses.add(value);
    for (const log of array(evidence.receipt.logs, "logs"))
      addresses.add(address(object(log, "log").address, "log address"));
    if (evidence.stateDiff.status === "collected")
      for (const value of Object.keys(evidence.stateDiff.value))
        addresses.add(value);
    for (const value of addresses)
      this.addWord(
        encodeAbiParameters(
          [{ type: "address" }],
          [address(value, "candidate address")],
        ),
      );
    for (const call of evidence.calls) {
      this.addWord(toHex(BigInt(call.value), { size: 32 }));
      this.addWords(`0x${call.input.slice(10)}`);
      this.addWords(call.output);
    }
    for (const value of array(evidence.receipt.logs, "logs")) {
      const log = object(value, "log");
      for (const topic of array(log.topics, "topics"))
        this.addWord(hex(topic, "topic", 32));
      this.addWords(hex(log.data, "log data"));
    }
    if (evidence.stateDiff.status === "collected")
      for (const value of Object.values(evidence.stateDiff.value)) {
        const storage = object(object(value, "account").storage, "storage");
        for (const change of Object.values(storage)) {
          if (change === "=") continue;
          const entry = object(change, "change");
          const values = entry["*"]
            ? Object.values(object(entry["*"], "change values"))
            : Object.values(entry);
          for (const value of values)
            this.addWord(hex(value, "storage word", 32));
        }
      }
  }

  addParameters(
    parameters: readonly AbiParameter[],
    values: readonly unknown[] | null,
    depth = 0,
  ): void {
    if (!values || depth > 24) return;
    parameters.forEach((parameter, index) => {
      const value = values[index];
      const arrayType = /^(.*)\[[0-9]*\]$/.exec(parameter.type);
      if (arrayType && Array.isArray(value)) {
        if (value.length > 256) this.truncated = true;
        for (const item of value.slice(0, 256))
          this.addParameters(
            [{ ...parameter, type: arrayType[1]! } as AbiParameter],
            [item],
            depth + 1,
          );
      } else if (
        parameter.type === "tuple" &&
        "components" in parameter &&
        value &&
        typeof value === "object"
      ) {
        this.addParameters(
          parameter.components,
          parameter.components.map((component, i) =>
            Array.isArray(value)
              ? value[i]
              : (value as Record<string, unknown>)[component.name ?? ""],
          ),
          depth + 1,
        );
      } else if (
        (parameter.type === "string" || parameter.type === "bytes") &&
        typeof value === "string"
      ) {
        const encoded =
          parameter.type === "string" ? toHex(value) : (value as Hex);
        const entries = this.dynamic.get(parameter.type) ?? [];
        if (entries.length >= 128) this.truncated = true;
        else if (!entries.some((entry) => entry.encoded === encoded))
          entries.push({ encoded, value, type: parameter.type });
        this.dynamic.set(parameter.type, entries);
      } else {
        try {
          const word = encodeAbiParameters([parameter], [value]);
          if (word.length === 66) this.addWord(word);
        } catch {
          /* Unsupported ABI types do not become mapping-key candidates. */
        }
      }
    });
  }

  keys(type: string): readonly MappingKey[] {
    if (type === "string" || type === "bytes")
      return this.dynamic.get(type) ?? [];
    if (
      !/^(address|bool|u?int(?:[0-9]+)|bytes(?:[1-9]|[12][0-9]|3[0-2]))$/.test(
        type,
      )
    )
      return [];
    const cached = this.keyCache.get(type);
    if (cached) return cached;
    const result: MappingKey[] = [];
    for (const word of this.words) {
      try {
        const [value] = decodeAbiParameters([{ type }], word);
        if (encodeAbiParameters([{ type }], [value]).toLowerCase() !== word)
          continue;
        result.push({ encoded: word, value, type });
        if (result.length >= 128) {
          this.truncated = true;
          break;
        }
      } catch {
        /* Word padding must agree with the declared mapping-key type. */
      }
    }
    this.keyCache.set(type, result);
    return result;
  }

  private addWords(value: Hex): void {
    for (let offset = 2; offset + 64 <= value.length; offset += 64)
      this.addWord(`0x${value.slice(offset, offset + 64)}`);
  }

  private addWord(value: Hex): void {
    this.keyCache.clear();
    if (this.words.size >= 512 && !this.words.has(value.toLowerCase() as Hex)) {
      this.truncated = true;
      return;
    }
    this.words.add(value.toLowerCase() as Hex);
  }
}
