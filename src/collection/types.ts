import type {
  Address,
  EIP1193RequestFn,
  Hash,
  Hex,
  PublicRpcSchema,
} from "viem";
import type { ChainName } from "../config/chains.js";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface TransactionRequest {
  readonly chain: ChainName;
  readonly transactionHash: Hash;
}

export interface TransactionIdentity extends TransactionRequest {
  readonly chainId: number;
  readonly blockHash: Hash;
  readonly blockNumber: number;
  readonly transactionIndex: number;
}

export type StateDiffEvidence =
  | { readonly status: "collected"; readonly value: JsonObject }
  | { readonly status: "not-requested" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface TransactionEvidence {
  readonly schemaVersion: 1;
  readonly identity: TransactionIdentity;
  readonly transaction: JsonObject;
  readonly receipt: JsonObject;
  readonly block: JsonObject;
  readonly traces: readonly JsonObject[];
  readonly stateDiff: StateDiffEvidence;
  readonly calls: readonly CallFrame[];
}

export interface CallFrame {
  readonly id: string;
  readonly parentId: string | null;
  readonly traceAddress: readonly number[];
  readonly type:
    | "CALL"
    | "STATICCALL"
    | "DELEGATECALL"
    | "CALLCODE"
    | "CREATE"
    | "CREATE2"
    | "SELFDESTRUCT";
  readonly from: Address;
  readonly to: Address | null;
  readonly storageContext: Address | null;
  readonly input: Hex;
  readonly output: Hex;
  readonly value: string;
  readonly reverted: boolean;
  readonly readOnly: boolean;
}

export interface CollectionCache {
  read(
    identity: TransactionIdentity,
    includeStateDiff: boolean,
  ): Promise<unknown | undefined>;
  write(
    evidence: TransactionEvidence,
    includeStateDiff: boolean,
  ): Promise<void>;
}

export type CollectionRpcSchema = [
  ...PublicRpcSchema,
  {
    Method: "trace_transaction";
    Parameters: [transactionHash: Hash];
    ReturnType: unknown;
  },
  {
    Method: "trace_replayTransaction";
    Parameters: [transactionHash: Hash, traceTypes: ["stateDiff"]];
    ReturnType: unknown;
  },
];

export interface RpcClient {
  readonly request: EIP1193RequestFn<CollectionRpcSchema>;
}

export interface TransactionCollector {
  collect(
    request: TransactionRequest,
    options: { readonly includeStateDiff: boolean },
  ): Promise<TransactionEvidence>;
}
