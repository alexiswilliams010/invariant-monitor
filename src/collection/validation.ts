import { isAddress, type Address, type Hash, type Hex } from "viem";
import type {
  JsonObject,
  TransactionIdentity,
  TransactionRequest,
} from "./types.js";
import { chains } from "../config/chains.js";

export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  return value as JsonObject;
}

export function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

export function hex(value: unknown, label: string, bytes?: number): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[a-fA-F0-9]{2})*$/.test(value) ||
    (bytes !== undefined && value.length !== 2 + bytes * 2)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.toLowerCase() as Hex;
}

export function hash(value: unknown, label = "transaction hash"): Hash {
  return hex(value, label, 32);
}

export function address(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw new Error(`Invalid ${label}.`);
  return value.toLowerCase() as Address;
}

export function quantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
    throw new Error(`Invalid ${label}.`);
  return BigInt(value);
}

export function index(value: unknown, label: string): number {
  const result =
    typeof value === "number" ? value : Number(quantity(value, label));
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`Invalid ${label}.`);
  return result;
}

export function identityOf(
  request: TransactionRequest,
  transaction: JsonObject,
  receipt: JsonObject,
): TransactionIdentity {
  const transactionHash = hash(request.transactionHash);
  if (
    hash(transaction.hash) !== transactionHash ||
    hash(receipt.transactionHash) !== transactionHash
  )
    throw new Error("Transaction and receipt identity mismatch.");
  const blockHash = hash(transaction.blockHash, "mined block hash");
  const blockNumber = index(transaction.blockNumber, "mined block number");
  const transactionIndex = index(
    transaction.transactionIndex,
    "transaction index",
  );
  if (
    hash(receipt.blockHash) !== blockHash ||
    index(receipt.blockNumber, "receipt block") !== blockNumber ||
    index(receipt.transactionIndex, "receipt position") !== transactionIndex
  )
    throw new Error("Transaction and receipt block mismatch.");
  address(transaction.from, "sender");
  if (transaction.to !== null) address(transaction.to, "recipient");
  hex(transaction.input, "calldata");
  quantity(transaction.value, "transaction value");
  if (receipt.status !== "0x0" && receipt.status !== "0x1")
    throw new Error("Invalid receipt status.");
  const seenLogs = new Set<number>();
  for (const entry of array(receipt.logs, "receipt logs")) {
    const log = object(entry, "receipt log");
    address(log.address, "log address");
    hex(log.data, "log data");
    for (const topic of array(log.topics, "log topics"))
      hex(topic, "log topic", 32);
    const logIndex = index(log.logIndex, "log index");
    if (
      seenLogs.has(logIndex) ||
      log.removed === true ||
      hash(log.transactionHash) !== transactionHash ||
      hash(log.blockHash) !== blockHash
    )
      throw new Error("Receipt log identity mismatch.");
    seenLogs.add(logIndex);
  }
  return {
    chain: request.chain,
    chainId: chains[request.chain].id,
    transactionHash,
    blockHash,
    blockNumber,
    transactionIndex,
  };
}

export function validateBlock(
  block: JsonObject,
  identity: TransactionIdentity,
): void {
  if (
    hash(block.hash) !== identity.blockHash ||
    index(block.number, "block number") !== identity.blockNumber
  )
    throw new Error("Canonical block changed during collection.");
  const transactions = array(block.transactions, "block transactions");
  if (
    hash(transactions[identity.transactionIndex]) !== identity.transactionHash
  )
    throw new Error("Transaction is not at its expected block position.");
}

export function validateStateDiff(value: unknown): JsonObject {
  const diff = object(value, "state diff");
  for (const [account, value] of Object.entries(diff)) {
    address(account, "state account");
    const state = object(value, "account diff");
    for (const field of ["balance", "nonce", "code"] as const) {
      validateChange(state[field], (item) =>
        field === "code"
          ? hex(item, "code diff")
          : quantity(item, "account diff"),
      );
    }
    for (const [slot, change] of Object.entries(
      object(state.storage, "storage diff"),
    )) {
      hex(slot, "storage slot", 32);
      validateChange(change, (item) => hex(item, "storage value", 32));
    }
  }
  return diff;
}

function validateChange(
  value: unknown,
  validate: (value: unknown) => unknown,
): void {
  if (value === "=") return;
  const change = object(value, "state change");
  const keys = Object.keys(change);
  if (keys.length !== 1) throw new Error("Invalid state change.");
  if (keys[0] === "+" || keys[0] === "-") validate(change[keys[0]]);
  else if (keys[0] === "*") {
    const values = object(change["*"], "changed values");
    validate(values.from);
    validate(values.to);
  } else throw new Error("Invalid state change operation.");
}
