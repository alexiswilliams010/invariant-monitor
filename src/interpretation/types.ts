import type { Address } from "viem";
import type { TransactionEvidence } from "../collection/types.js";
import type { ExecutionDisplay } from "../decoding/decoder.js";
import type { StorageChange } from "../decoding/storage.js";

export interface ContractTarget {
  readonly chainId: number;
  readonly address: Address;
}

export interface InterpretationContext {
  readonly evidence: TransactionEvidence;
  readonly display: ExecutionDisplay;
  readonly addresses: readonly {
    readonly address: Address;
    readonly name: string;
  }[];
}

export type EvidenceReference =
  | { readonly kind: "call"; readonly callId: string }
  | { readonly kind: "log"; readonly logIndex: number }
  | { readonly kind: "storage"; readonly changeId: string };

export interface FactEvidence {
  readonly references: readonly EvidenceReference[];
  readonly basis: "event-reported" | "state-observed" | "inferred";
  readonly position:
    | { readonly kind: "transaction" }
    | { readonly kind: "call"; readonly callId: string };
}

export interface AssetIdentity {
  readonly contract: Address | null;
  readonly tokenId?: string;
  readonly symbol?: string;
  readonly decimals?: number;
}

export type InterpretationFact = (
  | {
      readonly kind: "asset-movement";
      readonly asset: AssetIdentity;
      readonly from: Address | null;
      readonly to: Address | null;
      readonly amount: string;
    }
  | {
      readonly kind: "asset-balance-change";
      readonly asset: AssetIdentity;
      readonly holder: Address;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "contract-state-change";
      readonly contract: Address;
      readonly change: StorageChange;
    }
) & { readonly evidence: FactEvidence };

export interface InterpretationResult {
  readonly status: "interpreted" | "not-applicable" | "unavailable";
  readonly facts: readonly InterpretationFact[];
}

export interface InterpretationAdapter {
  readonly id: string;
  readonly scope:
    | { readonly kind: "standard" }
    | ({ readonly kind: "contract" } & ContractTarget);
  interpret(context: InterpretationContext): Promise<InterpretationResult>;
}

export interface InterpretationDocument {
  readonly schemaVersion: 1;
  readonly identity: TransactionEvidence["identity"];
  readonly interpretations: readonly (InterpretationResult & {
    readonly adapterId: string;
  })[];
}
