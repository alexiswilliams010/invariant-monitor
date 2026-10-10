import { array, object } from "../collection/validation.js";

export interface StorageField {
  readonly label: string;
  readonly slot: bigint;
  readonly offset: number;
  readonly type: string;
}

export interface StorageType {
  readonly encoding: string;
  readonly label: string;
  readonly bytes: bigint;
  readonly key?: string;
  readonly value?: string;
  readonly base?: string;
  readonly members?: readonly StorageField[];
}

export class SolidityStorageLayout {
  private constructor(
    readonly fields: readonly StorageField[],
    readonly types: ReadonlyMap<string, StorageType>,
  ) {}

  static parse(value: unknown): SolidityStorageLayout | null {
    try {
      const layout = object(value, "storage layout");
      const fields = array(layout.storage, "storage fields").map(field);
      const types = new Map<string, StorageType>();
      for (const [id, value] of Object.entries(
        layout.types == null && fields.length === 0
          ? {}
          : object(layout.types, "storage types"),
      )) {
        const item = object(value, "storage type");
        if (typeof item.label !== "string" || typeof item.encoding !== "string")
          return null;
        const bytes = decimal(item.numberOfBytes);
        if (bytes === 0n) return null;
        const integer = /^(?:u?int)([0-9]+)$/.exec(item.label);
        const fixedBytes = /^bytes([0-9]+)$/.exec(item.label);
        if (
          integer &&
          (Number(integer[1]) < 8 ||
            Number(integer[1]) > 256 ||
            Number(integer[1]) % 8 !== 0 ||
            bytes !== BigInt(integer[1]!) / 8n)
        )
          return null;
        if (
          fixedBytes &&
          (bytes < 1n || bytes > 32n || bytes !== BigInt(fixedBytes[1]!))
        )
          return null;
        if (item.label === "bool" && bytes !== 1n) return null;
        if (
          (item.label === "address" ||
            item.label === "address payable" ||
            item.label.startsWith("contract ")) &&
          bytes !== 20n
        )
          return null;
        const links: { key?: string; value?: string; base?: string } = {};
        for (const name of ["key", "value", "base"] as const) {
          if (item[name] !== undefined) {
            if (typeof item[name] !== "string") return null;
            links[name] = item[name];
          }
        }
        types.set(id, {
          encoding: item.encoding,
          label: item.label,
          bytes,
          ...links,
          ...(item.members === undefined
            ? {}
            : { members: array(item.members, "struct members").map(field) }),
        });
      }
      for (const entry of fields) if (!types.has(entry.type)) return null;
      for (const type of types.values()) {
        for (const link of [
          type.key,
          type.value,
          type.base,
          ...(type.members?.map((member) => member.type) ?? []),
        ])
          if (link !== undefined && !types.has(link)) return null;
        if (type.encoding === "mapping" && (!type.key || !type.value))
          return null;
        if (type.encoding === "dynamic_array" && !type.base) return null;
      }
      return new SolidityStorageLayout(fields, types);
    } catch {
      return null;
    }
  }
}

function field(value: unknown): StorageField {
  const item = object(value, "storage field");
  if (
    typeof item.label !== "string" ||
    typeof item.type !== "string" ||
    typeof item.offset !== "number" ||
    !Number.isInteger(item.offset) ||
    item.offset < 0 ||
    item.offset > 31
  )
    throw new Error("Invalid storage field.");
  return {
    label: item.label,
    slot: decimal(item.slot),
    offset: item.offset,
    type: item.type,
  };
}

function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Invalid storage number.");
  const number = BigInt(value);
  if (number >= 1n << 256n) throw new Error("Storage number too large.");
  return number;
}
