import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CollectionCache,
  TransactionEvidence,
  TransactionIdentity,
} from "./types.js";

export class FileCollectionCache implements CollectionCache {
  constructor(private readonly directory: string) {}

  async read(
    identity: TransactionIdentity,
    includeStateDiff: boolean,
  ): Promise<unknown | undefined> {
    try {
      return JSON.parse(
        await readFile(this.path(identity, includeStateDiff), "utf8"),
      ) as unknown;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new Error("Cannot read collection cache. Retry with --no-cache.");
    }
  }

  async write(
    evidence: TransactionEvidence,
    includeStateDiff: boolean,
  ): Promise<void> {
    const destination = this.path(evidence.identity, includeStateDiff);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(evidence), { flag: "wx" });
    await rename(temporary, destination);
  }

  private path(
    identity: TransactionIdentity,
    includeStateDiff: boolean,
  ): string {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          1,
          identity.chainId,
          identity.blockHash,
          identity.transactionHash,
          includeStateDiff,
        ]),
      )
      .digest("hex");
    return join(this.directory, `${key}.json`);
  }
}
