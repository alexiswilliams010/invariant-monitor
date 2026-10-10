import { keccak256 } from "viem";
import { address, array, hash, hex, object } from "../collection/validation.js";
import type {
  ContractIdentity,
  ContractMetadata,
  MatchQuality,
  MetadataProvider,
  MetadataResult,
} from "./types.js";

const fields = [
  "abi",
  "storageLayout",
  "compilation.name",
  "compilation.fullyQualifiedName",
  "compilation.language",
  "compilation.compiler",
  "compilation.compilerVersion",
  "deployment",
  "runtimeBytecode.onchainBytecode",
].join(",");

export class SourcifyMetadataProvider implements MetadataProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async lookup(request: ContractIdentity): Promise<MetadataResult> {
    const identity = contractIdentity(request);
    const url = new URL(
      `https://sourcify.dev/server/v2/contract/${identity.chainId}/${identity.address}`,
    );
    url.searchParams.set("fields", fields);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return {
        status: "unavailable",
        reason: "Sourcify transport or timeout failure.",
      };
    }
    if (!response.ok && response.status !== 404) {
      await response.body?.cancel();
      return {
        status: "unavailable",
        reason: `Sourcify HTTP ${response.status}.`,
      };
    }
    try {
      const body = object(await response.json(), "Sourcify response");
      if (
        body.chainId !== String(identity.chainId) ||
        address(body.address, "metadata address") !== identity.address
      )
        throw new Error("Sourcify identity mismatch.");
      if (response.status === 404) {
        if (
          body.match !== null ||
          body.runtimeMatch !== null ||
          body.creationMatch !== null
        )
          throw new Error("Invalid not-found response.");
        return { status: "not-found" };
      }
      if (quality(body.match) === null)
        throw new Error("Missing verification match.");
      const compilation =
        body.compilation == null ? {} : object(body.compilation, "compilation");
      const deployment =
        body.deployment == null ? {} : object(body.deployment, "deployment");
      const runtime =
        body.runtimeBytecode == null
          ? {}
          : object(body.runtimeBytecode, "runtime bytecode");
      const metadata: ContractMetadata = {
        schemaVersion: 1,
        identity,
        source: "sourcify",
        fetchedAt: new Date().toISOString(),
        matchId: decimal(body.matchId),
        verifiedAt: timestamp(body.verifiedAt),
        creationMatch: quality(body.creationMatch),
        runtimeMatch: quality(body.runtimeMatch),
        compilation: {
          name: optionalText(compilation.name),
          fullyQualifiedName: optionalText(compilation.fullyQualifiedName),
          language: optionalText(compilation.language),
          compiler: optionalText(compilation.compiler),
          compilerVersion: optionalText(compilation.compilerVersion),
        },
        deployment: {
          transactionHash:
            deployment.transactionHash == null
              ? null
              : hash(deployment.transactionHash),
          blockNumber:
            deployment.blockNumber == null
              ? null
              : decimal(deployment.blockNumber),
          transactionIndex:
            deployment.transactionIndex == null
              ? null
              : decimal(deployment.transactionIndex),
          deployer:
            deployment.deployer == null
              ? null
              : address(deployment.deployer, "deployer"),
        },
        runtimeCodeHash:
          runtime.onchainBytecode == null
            ? null
            : keccak256(hex(runtime.onchainBytecode, "runtime bytecode")),
        abi:
          body.abi == null
            ? null
            : array(body.abi, "ABI").map((item) => object(item, "ABI item")),
        storageLayout:
          body.storageLayout == null
            ? null
            : object(body.storageLayout, "storage layout"),
      };
      return { status: "found", metadata };
    } catch {
      return { status: "unavailable", reason: "Invalid Sourcify response." };
    }
  }
}

export function contractIdentity(value: ContractIdentity): ContractIdentity {
  if (!Number.isSafeInteger(value.chainId) || value.chainId <= 0)
    throw new Error("Invalid metadata chain ID.");
  return {
    chainId: value.chainId,
    address: address(value.address, "metadata address"),
  };
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error("Invalid metadata text.");
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Invalid metadata number.");
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid verification timestamp.");
  return value;
}

function quality(value: unknown): MatchQuality {
  if (value === null || value === "match" || value === "exact_match")
    return value;
  throw new Error("Invalid verification quality.");
}
