import type { Address, Hash } from "viem";
import type { JsonObject } from "../collection/types.js";

export interface ContractIdentity {
  readonly chainId: number;
  readonly address: Address;
}

export type MatchQuality = "exact_match" | "match" | null;

export interface ContractMetadata {
  readonly schemaVersion: 1;
  readonly identity: ContractIdentity;
  readonly source: "sourcify";
  readonly fetchedAt: string;
  readonly matchId: string;
  readonly verifiedAt: string;
  readonly creationMatch: MatchQuality;
  readonly runtimeMatch: MatchQuality;
  readonly compilation: {
    readonly name: string | null;
    readonly fullyQualifiedName: string | null;
    readonly language: string | null;
    readonly compiler: string | null;
    readonly compilerVersion: string | null;
  };
  readonly deployment: {
    readonly transactionHash: Hash | null;
    readonly blockNumber: string | null;
    readonly transactionIndex: string | null;
    readonly deployer: Address | null;
  };
  readonly runtimeCodeHash: Hash | null;
  // Compiler artifacts retain their native shape until the decoding layer validates them.
  readonly abi: readonly JsonObject[] | null;
  readonly storageLayout: JsonObject | null;
}

export type MetadataResult =
  | { readonly status: "found"; readonly metadata: ContractMetadata }
  | { readonly status: "not-found" }
  | { readonly status: "offline-miss" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface MetadataProvider {
  lookup(identity: ContractIdentity): Promise<MetadataResult>;
}

export interface MetadataStore {
  read(identity: ContractIdentity): Promise<ContractMetadata | undefined>;
  write(metadata: ContractMetadata): Promise<void>;
}
