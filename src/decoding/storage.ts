import { concatHex, keccak256, toHex, type Address } from "viem";
import type { TransactionEvidence } from "../collection/types.js";
import type { ContractMetadata } from "../metadata/types.js";
import { object } from "../collection/validation.js";
import { AddressNames, displayArguments, displayText } from "./presentation.js";
import { StorageCandidates, type MappingKey } from "./storage-candidates.js";
import { SolidityStorageLayout, type StorageType } from "./storage-layout.js";

export interface StorageChange {
  readonly id: string;
  readonly contract: string;
  readonly name: string;
  readonly type?: string;
  readonly before?: string | boolean;
  readonly after?: string | boolean;
  readonly delta?: string;
}

export interface StorageDisplay {
  readonly status: "collected" | "not-requested" | "unavailable";
  readonly changes: readonly StorageChange[];
}

type Path = readonly (string | MappingKey)[];
interface Leaf {
  path: Path;
  type: StorageType;
  offset: number;
  bytes: number;
}
interface Words {
  before: bigint;
  after: bigint;
}
const modulus = 1n << 256n;
const fullMask = modulus - 1n;

export class StorageDecoder {
  constructor(
    private readonly candidates: StorageCandidates,
    private readonly names: AddressNames,
  ) {}

  decode(
    evidence: TransactionEvidence,
    metadata: ReadonlyMap<Address, ContractMetadata>,
  ) {
    const changes: StorageChange[] = [];
    const slots: {
      address: Address;
      slot: string;
      status: "attributed" | "partial" | "unknown" | "ambiguous";
      changes: string[];
    }[] = [];
    let limited = false;
    if (evidence.stateDiff.status !== "collected")
      return {
        display: { status: evidence.stateDiff.status, changes },
        diagnostics: {
          slots,
          limited,
          candidatesLimited: this.candidates.truncated,
        },
      };
    let accountIndex = 0;
    for (const [rawAddress, value] of Object.entries(
      evidence.stateDiff.value,
    )) {
      const account = rawAddress.toLowerCase() as Address;
      const raw = object(
        object(value, "state account").storage,
        "storage changes",
      );
      const words = new Map<string, Words>();
      for (const [slot, change] of Object.entries(raw)) {
        if (change === "=") continue;
        const entry = object(change, "slot change");
        const modified = entry["*"] ? object(entry["*"], "slot values") : null;
        words.set(BigInt(slot).toString(), {
          before: BigInt((modified?.from ?? entry["-"] ?? "0x0") as string),
          after: BigInt((modified?.to ?? entry["+"] ?? "0x0") as string),
        });
      }
      if (!words.size) continue;
      const layouts = new Set<SolidityStorageLayout>();
      const usedCode = new Set<Address>();
      for (const call of evidence.calls) {
        if (
          call.reverted ||
          call.readOnly ||
          call.storageContext !== account ||
          !call.to ||
          usedCode.has(call.to)
        )
          continue;
        usedCode.add(call.to);
        const contract = metadata.get(call.to);
        if (contract?.compilation.language !== "Solidity") continue;
        const layout = SolidityStorageLayout.parse(contract.storageLayout);
        if (layout) layouts.add(layout);
      }
      const index = new Map<string, Leaf[]>();
      for (const layout of layouts) {
        const builder = new LayoutIndex(layout, words, this.candidates);
        const result = builder.build();
        limited ||= builder.limited;
        // An unfinished search cannot rule out conflicting attributions in that layout.
        if (builder.exhausted) {
          index.clear();
          break;
        }
        for (const [slot, leaves] of result)
          index.set(slot, [...(index.get(slot) ?? []), ...leaves]);
      }
      let slotIndex = 0;
      for (const [slot, word] of words) {
        const id = `${accountIndex}.${slotIndex++}`;
        const leaves = [
          ...new Map(
            (index.get(slot) ?? []).map((leaf) => [leafIdentity(leaf), leaf]),
          ).values(),
        ];
        const ambiguous = leaves.some((a, i) =>
          leaves.slice(i + 1).some((b) => (mask(a) & mask(b)) !== 0n),
        );
        let covered = 0n;
        const ids: string[] = [];
        if (!ambiguous)
          for (const leaf of leaves) {
            covered |= mask(leaf);
            const shift = BigInt(leaf.offset * 8);
            const before = (word.before & mask(leaf)) >> shift;
            const after = (word.after & mask(leaf)) >> shift;
            if (before === after) continue;
            const changeId = `${id}.${ids.length}`;
            const oldValue = scalar(leaf.type, before, this.names);
            const newValue = scalar(leaf.type, after, this.names);
            const numeric = /^u?int(?:[0-9]+)$/.test(leaf.type.label);
            changes.push({
              id: changeId,
              contract: this.names.register(account),
              name: pathName(leaf.path, this.names),
              type: displayText(leaf.type.label),
              ...(oldValue === undefined ? {} : { before: oldValue }),
              ...(newValue === undefined ? {} : { after: newValue }),
              ...(numeric &&
              typeof oldValue === "string" &&
              typeof newValue === "string"
                ? { delta: (BigInt(newValue) - BigInt(oldValue)).toString() }
                : {}),
            });
            ids.push(changeId);
          }
        const remaining = (word.before ^ word.after) & (fullMask ^ covered);
        if (ambiguous || remaining !== 0n || !leaves.length) {
          const changeId = `${id}.${ids.length}`;
          changes.push({
            id: changeId,
            contract: this.names.register(account),
            name: "storage",
          });
          ids.push(changeId);
        }
        slots.push({
          address: account,
          slot: toHex(BigInt(slot), { size: 32 }),
          status: ambiguous
            ? "ambiguous"
            : leaves.length === 0
              ? "unknown"
              : remaining !== 0n
                ? "partial"
                : "attributed",
          changes: ids,
        });
      }
      accountIndex++;
    }
    return {
      display: { status: "collected" as const, changes },
      diagnostics: {
        slots,
        limited,
        candidatesLimited: this.candidates.truncated,
      },
    };
  }
}

class LayoutIndex {
  readonly leaves = new Map<string, Leaf[]>();
  limited = false;
  exhausted = false;
  private visits = 0;

  constructor(
    private readonly layout: SolidityStorageLayout,
    private readonly words: ReadonlyMap<string, Words>,
    private readonly candidates: StorageCandidates,
  ) {}

  build(): ReadonlyMap<string, Leaf[]> {
    for (const field of this.layout.fields)
      this.walk(field.type, field.slot, field.offset, [field.label], 0);
    return this.leaves;
  }

  private walk(
    id: string,
    slot: bigint,
    offset: number,
    path: Path,
    depth: number,
  ): void {
    if (this.exhausted) return;
    if (++this.visits > 50_000 || depth > 24) {
      this.limited = this.exhausted = true;
      return;
    }
    slot %= modulus;
    const type = this.layout.types.get(id)!;
    if (type.encoding === "mapping") {
      const key = this.layout.types.get(type.key!)!;
      const keyType = key.label.startsWith("contract ") ? "address" : key.label;
      for (const candidate of this.candidates.keys(keyType)) {
        const location = BigInt(
          keccak256(concatHex([candidate.encoded, toHex(slot, { size: 32 })])),
        );
        this.walk(type.value!, location, 0, [...path, candidate], depth + 1);
        if (this.exhausted) break;
      }
    } else if (type.members) {
      for (const member of type.members)
        this.walk(
          member.type,
          slot + member.slot,
          member.offset,
          [...path, `.${member.label}`],
          depth + 1,
        );
    } else if (type.base) {
      const dynamic = type.encoding === "dynamic_array";
      const size = this.words.get(slot.toString());
      const match = /\[([0-9]+)\]$/.exec(type.label);
      const length = dynamic
        ? size
          ? size.before > size.after
            ? size.before
            : size.after
          : null
        : match
          ? BigInt(match[1]!)
          : null;
      if (dynamic)
        this.add(slot, 0, [...path, ".length"], {
          encoding: "inplace",
          label: "uint256",
          bytes: 32n,
        });
      if (length === null || length > 256n) {
        this.limited = true;
        return;
      }
      const base = this.layout.types.get(type.base)!;
      const start = dynamic
        ? BigInt(keccak256(toHex(slot, { size: 32 })))
        : slot;
      const packed =
        base.encoding === "inplace" &&
        !base.members &&
        !base.base &&
        base.bytes <= 32n;
      const perSlot = packed ? 32n / base.bytes : 1n;
      const stride = packed ? 1n : (base.bytes + 31n) / 32n;
      for (let i = 0n; i < length; i++)
        this.walk(
          type.base,
          start + (i / perSlot) * stride,
          packed ? Number((i % perSlot) * base.bytes) : 0,
          [...path, `[${i}]`],
          depth + 1,
        );
    } else if (type.encoding === "bytes") {
      this.add(slot, 0, path, type);
      const word = this.words.get(slot.toString());
      if (!word) return;
      const length = [word.before, word.after].reduce(
        (max, value) => (value % 2n && value / 2n > max ? value / 2n : max),
        0n,
      );
      if (length > 8192n) {
        this.limited = true;
        return;
      }
      const start = BigInt(keccak256(toHex(slot, { size: 32 })));
      for (let i = 0n; i < (length + 31n) / 32n; i++)
        this.add((start + i) % modulus, 0, path, {
          encoding: "inplace",
          label: type.label === "string" ? "string" : "bytes",
          bytes: 32n,
        });
    } else if (type.encoding === "inplace") this.add(slot, offset, path, type);
  }

  private add(
    slot: bigint,
    offset: number,
    path: Path,
    type: StorageType,
  ): void {
    if (
      !this.words.has(slot.toString()) ||
      type.bytes > 32n ||
      offset + Number(type.bytes) > 32
    )
      return;
    const entries = this.leaves.get(slot.toString()) ?? [];
    entries.push({ path, type, offset, bytes: Number(type.bytes) });
    this.leaves.set(slot.toString(), entries);
  }
}

function leafIdentity(leaf: Leaf): string {
  return JSON.stringify([
    leaf.path.map((part) =>
      typeof part === "string" ? part : [part.type, part.encoded],
    ),
    leaf.offset,
    leaf.bytes,
    leaf.type.label,
    leaf.type.encoding,
  ]);
}

function mask(leaf: Leaf): bigint {
  return ((1n << BigInt(leaf.bytes * 8)) - 1n) << BigInt(leaf.offset * 8);
}

function pathName(path: Path, names: AddressNames): string {
  return path
    .map((part) => {
      if (typeof part === "string") return displayText(part);
      const value = displayArguments(
        [{ type: part.type }],
        [part.value],
        names,
      )[0]?.value;
      return `[${typeof value === "string" || typeof value === "boolean" ? value : "unknown"}]`;
    })
    .join("");
}

function scalar(
  type: StorageType,
  value: bigint,
  names: AddressNames,
): string | boolean | undefined {
  if (/^uint(?:[0-9]+)$/.test(type.label)) return value.toString();
  if (/^int(?:[0-9]+)$/.test(type.label)) {
    const bits = type.bytes * 8n;
    return (
      value >= 1n << (bits - 1n) ? value - (1n << bits) : value
    ).toString();
  }
  if (type.label === "bool") return value <= 1n ? value === 1n : undefined;
  if (
    type.label === "address" ||
    type.label === "address payable" ||
    type.label.startsWith("contract ")
  )
    return type.bytes === 20n
      ? names.register(toHex(value, { size: 20 }))
      : undefined;
  if (
    type.encoding === "bytes" &&
    type.label === "string" &&
    value % 2n === 0n
  ) {
    const length = Number(value & 255n) / 2;
    if (length > 31) return undefined;
    try {
      return displayText(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(
            toHex(value, { size: 32 }).slice(2, 2 + length * 2),
            "hex",
          ),
        ),
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
}
