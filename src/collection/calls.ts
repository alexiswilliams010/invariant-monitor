import type { CallFrame, JsonObject, TransactionIdentity } from "./types.js";
import {
  address,
  array,
  hash,
  hex,
  index,
  object,
  quantity,
} from "./validation.js";

export function normalizeCalls(
  raw: unknown,
  identity: TransactionIdentity,
  transaction: JsonObject,
  receipt: JsonObject,
): { traces: readonly JsonObject[]; calls: readonly CallFrame[] } {
  const entries = array(raw, "call traces").map((value) => {
    const trace = object(value, "call trace");
    if (
      trace.transactionHash !== undefined &&
      hash(trace.transactionHash) !== identity.transactionHash
    )
      throw new Error("Trace transaction mismatch.");
    if (
      trace.blockHash !== undefined &&
      hash(trace.blockHash) !== identity.blockHash
    )
      throw new Error("Trace block mismatch.");
    if (
      trace.blockNumber !== undefined &&
      index(trace.blockNumber, "trace block") !== identity.blockNumber
    )
      throw new Error("Trace block number mismatch.");
    if (
      trace.transactionPosition !== undefined &&
      index(trace.transactionPosition, "trace transaction position") !==
        identity.transactionIndex
    )
      throw new Error("Trace transaction position mismatch.");
    const path = array(trace.traceAddress, "trace address").map((part) =>
      index(part, "trace address component"),
    );
    return { trace, path };
  });
  entries.sort((a, b) => {
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
      const difference = a.path[i]! - b.path[i]!;
      if (difference !== 0) return difference;
    }
    return a.path.length - b.path.length;
  });
  if (entries.length === 0 || entries[0]!.path.length !== 0)
    throw new Error("Missing root call trace.");
  const calls = new Map<string, CallFrame>();
  const childCounts = new Map<string, number>();
  for (const { trace, path } of entries) {
    const id = callId(path);
    const parentId = path.length ? callId(path.slice(0, -1)) : null;
    const parent = parentId === null ? undefined : calls.get(parentId);
    if (calls.has(id) || (parentId !== null && !parent))
      throw new Error("Duplicate trace or missing parent.");
    if (parentId !== null) {
      const count = childCounts.get(parentId) ?? 0;
      if (path.at(-1) !== count)
        throw new Error("Non-contiguous child traces.");
      childCounts.set(parentId, count + 1);
    }
    const action = object(trace.action, "trace action");
    const result =
      trace.result == null ? undefined : object(trace.result, "trace result");
    if (trace.error !== undefined && typeof trace.error !== "string")
      throw new Error("Invalid trace error.");
    if (!result && trace.error === undefined && trace.type !== "suicide")
      throw new Error("Missing trace result.");
    const type = callType(trace, action);
    const from = address(
      type === "SELFDESTRUCT" ? action.address : action.from,
      "call sender",
    );
    const creation = type === "CREATE" || type === "CREATE2";
    const to = creation
      ? result?.address == null
        ? null
        : address(result.address, "created contract")
      : address(
          type === "SELFDESTRUCT" ? action.refundAddress : action.to,
          "call recipient",
        );
    const inherited = type === "DELEGATECALL" || type === "CALLCODE";
    if (inherited && !parent)
      throw new Error("Delegated call has no parent context.");
    calls.set(id, {
      id,
      parentId,
      traceAddress: path,
      type,
      from,
      to,
      storageContext: inherited
        ? parent!.storageContext
        : type === "SELFDESTRUCT"
          ? from
          : to,
      input:
        type === "SELFDESTRUCT"
          ? "0x"
          : hex(creation ? action.init : action.input, "call input"),
      output:
        type === "SELFDESTRUCT"
          ? "0x"
          : hex(
              (creation ? result?.code : result?.output) ?? "0x",
              "call output",
            ),
      value: quantity(
        type === "SELFDESTRUCT" ? action.balance : action.value,
        "call value",
      ).toString(),
      reverted: Boolean(parent?.reverted || trace.error !== undefined),
      readOnly: Boolean(parent?.readOnly || type === "STATICCALL"),
    });
  }
  for (const { trace, path } of entries) {
    if (
      index(trace.subtraces, "subtrace count") !==
      (childCounts.get(callId(path)) ?? 0)
    )
      throw new Error("Incomplete call trace tree.");
  }
  const root = calls.get("root")!;
  if (
    root.reverted !== (receipt.status === "0x0") ||
    root.from !== address(transaction.from, "sender") ||
    root.value !==
      quantity(transaction.value, "transaction value").toString() ||
    root.input !== hex(transaction.input, "transaction input")
  )
    throw new Error("Root trace disagrees with transaction or receipt.");
  if (
    transaction.to !== null &&
    (root.type !== "CALL" ||
      root.to !== address(transaction.to, "transaction recipient"))
  )
    throw new Error("Root trace target mismatch.");
  if (
    transaction.to === null &&
    (!(root.type === "CREATE" || root.type === "CREATE2") ||
      (!root.reverted &&
        root.to !== address(receipt.contractAddress, "receipt contract")))
  )
    throw new Error("Root creation mismatch.");
  return {
    traces: entries.map(({ trace }) => trace),
    calls: [...calls.values()],
  };
}

function callId(path: readonly number[]): string {
  return path.length ? path.join(".") : "root";
}

function callType(trace: JsonObject, action: JsonObject): CallFrame["type"] {
  if (trace.type === "suicide") return "SELFDESTRUCT";
  if (trace.type === "create") {
    if (action.creationMethod === "create2") return "CREATE2";
    if (
      action.creationMethod === undefined ||
      action.creationMethod === "create"
    )
      return "CREATE";
  }
  if (trace.type === "call") {
    switch (action.callType) {
      case "call":
        return "CALL";
      case "staticcall":
        return "STATICCALL";
      case "delegatecall":
        return "DELEGATECALL";
      case "callcode":
        return "CALLCODE";
    }
  }
  throw new Error("Unsupported trace action type.");
}
