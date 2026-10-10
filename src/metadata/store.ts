import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { object } from "../collection/validation.js";
import { contractIdentity } from "./sourcify.js";
import type {
  ContractIdentity,
  ContractMetadata,
  MetadataStore,
} from "./types.js";

export class FileMetadataStore implements MetadataStore {
  constructor(private readonly directory: string) {}

  async read(request: ContractIdentity): Promise<ContractMetadata | undefined> {
    const identity = contractIdentity(request);
    const pointer = await this.readJson(this.path(identity));
    if (pointer === undefined) return undefined;
    const entry = object(pointer, "metadata index");
    if (entry.schemaVersion !== 1)
      throw new Error("Unsupported metadata cache version.");
    const record = object(await this.readBlob(entry.record), "metadata record");
    const savedIdentity = object(record.identity, "metadata identity");
    if (
      record.schemaVersion !== 1 ||
      record.source !== "sourcify" ||
      savedIdentity.chainId !== identity.chainId ||
      savedIdentity.address !== identity.address
    )
      throw new Error("Metadata cache identity mismatch.");
    const abi = record.abi === null ? null : await this.readBlob(record.abi);
    const storageLayout =
      record.storageLayout === null
        ? null
        : await this.readBlob(record.storageLayout);
    if (
      abi !== null &&
      (!Array.isArray(abi) ||
        abi.some(
          (item) => !item || typeof item !== "object" || Array.isArray(item),
        ))
    )
      throw new Error("Invalid cached ABI.");
    if (storageLayout !== null) object(storageLayout, "cached storage layout");
    return { ...record, abi, storageLayout } as unknown as ContractMetadata;
  }

  async write(metadata: ContractMetadata): Promise<void> {
    const identity = contractIdentity(metadata.identity);
    const abi =
      metadata.abi === null ? null : await this.writeBlob(metadata.abi);
    const storageLayout =
      metadata.storageLayout === null
        ? null
        : await this.writeBlob(metadata.storageLayout);
    const record = await this.writeBlob({
      ...metadata,
      identity,
      abi,
      storageLayout,
    });
    await this.writeJson(this.path(identity), { schemaVersion: 1, record });
  }

  private path(identity: ContractIdentity): string {
    return join(
      this.directory,
      "contracts",
      String(identity.chainId),
      `${identity.address}.json`,
    );
  }

  private async readBlob(value: unknown): Promise<unknown> {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      throw new Error("Invalid metadata content reference.");
    const blob = await this.readJson(
      join(this.directory, "objects", `${value}.json`),
    );
    if (blob === undefined || digest(blob) !== value)
      throw new Error("Missing or corrupt metadata content.");
    return blob;
  }

  private async writeBlob(value: unknown): Promise<string> {
    const id = digest(value);
    await this.writeJson(join(this.directory, "objects", `${id}.json`), value);
    return id;
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new Error("Cannot read metadata cache.");
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, canonical(value), { flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Invalid metadata JSON.");
  return serialized;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
