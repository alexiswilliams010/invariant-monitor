import { parseChain } from "../config/chains.js";
import { normalizeCalls } from "../collection/calls.js";
import {
  hash,
  identityOf,
  object,
  validateBlock,
  validateStateDiff,
} from "../collection/validation.js";
import type {
  StateDiffEvidence,
  TransactionEvidence,
} from "../collection/types.js";

export function readEvidence(value: unknown): TransactionEvidence {
  const data = object(value, "evidence");
  if (data.schemaVersion !== 1)
    throw new Error("Unsupported evidence version.");
  const saved = object(data.identity, "identity");
  if (typeof saved.chain !== "string")
    throw new Error("Invalid evidence chain.");
  const transaction = object(data.transaction, "transaction");
  const receipt = object(data.receipt, "receipt");
  const identity = identityOf(
    {
      chain: parseChain(saved.chain),
      transactionHash: hash(saved.transactionHash),
    },
    transaction,
    receipt,
  );
  if (Object.entries(identity).some(([key, item]) => saved[key] !== item))
    throw new Error("Evidence identity mismatch.");
  const block = object(data.block, "block");
  validateBlock(block, identity);
  const diff = object(data.stateDiff, "state diff status");
  let stateDiff: StateDiffEvidence;
  if (diff.status === "collected")
    stateDiff = { status: "collected", value: validateStateDiff(diff.value) };
  else if (diff.status === "not-requested")
    stateDiff = { status: "not-requested" };
  else if (diff.status === "unavailable" && typeof diff.reason === "string")
    stateDiff = { status: "unavailable", reason: diff.reason };
  else throw new Error("Invalid state diff status.");
  return {
    schemaVersion: 1,
    identity,
    transaction,
    receipt,
    block,
    stateDiff,
    ...normalizeCalls(data.traces, identity, transaction, receipt),
  };
}
