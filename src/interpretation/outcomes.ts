import { formatUnits } from "viem";
import { stringify } from "yaml";
import { displayText } from "../decoding/presentation.js";
import type { StorageChange } from "../decoding/storage.js";
import { ParticipantNameResolver } from "../rendering/names.js";
import type { DiagramInput } from "../rendering/sequence.js";
import type { InterpretationContext } from "./types.js";
import type { TokenInterpretation } from "./tokens.js";
import {
  TokenBalanceReader,
  balanceKey,
  balancePercentage,
  type ObservedTokenBalance,
} from "./balances.js";

export interface OutcomeDocument {
  version: 1;
  chain: string;
  status: "success" | "reverted";
  token_net_from_transfers: Record<string, string[]>;
  decoded_state: Record<
    string,
    {
      field: string;
      type: string;
      before: string | boolean;
      after: string | boolean;
    }[]
  >;
}

export class OutcomeExporter {
  build(
    context: InterpretationContext,
    tokens: TokenInterpretation,
    diagram: DiagramInput,
    diagramNames: ReadonlyMap<string, string>,
  ) {
    const names = new Map(diagramNames);
    const preferred = new ParticipantNameResolver().resolve(diagram);
    const used = new Set(names.values());
    const name = (identity: string): string => {
      const existing = names.get(identity);
      if (existing) return existing;
      const base = displayText(preferred.get(identity) ?? identity);
      let label = base;
      let suffix = 2;
      while (used.has(label)) label = `${base}_${suffix++}`;
      names.set(identity, label);
      used.add(label);
      return label;
    };
    const aliases = new Map(
      context.addresses.map((entry) => [
        entry.address.toLowerCase(),
        entry.name,
      ]),
    );
    for (const [address, alias] of diagram.addressNames ?? [])
      aliases.set(address.toLowerCase(), alias);
    let nextHolder = 1;
    const holderName = (address: string) => {
      const key = address.toLowerCase();
      if (!aliases.has(key)) {
        let alias: string;
        do {
          alias = `Holder_${nextHolder++}`;
        } while ([...aliases.values()].includes(alias) || names.has(alias));
        aliases.set(key, alias);
      }
      return name(aliases.get(key)!);
    };
    const totals = new Map<
      string,
      Map<string, { amount: bigint; logs: number[] }>
    >();
    const add = (
      holder: string | null,
      asset: string,
      amount: bigint,
      log: number,
    ) => {
      if (holder === null || amount === 0n) return;
      const key = holder.toLowerCase();
      const assets = totals.get(key) ?? new Map();
      const total = assets.get(asset) ?? { amount: 0n, logs: [] };
      total.amount += amount;
      total.logs.push(log);
      assets.set(asset, total);
      totals.set(key, assets);
    };
    for (const movement of tokens.movements) {
      const amount = BigInt(movement.amount);
      add(
        movement.from,
        movement.asset.toLowerCase(),
        -amount,
        movement.logIndex,
      );
      add(movement.to, movement.asset.toLowerCase(), amount, movement.logIndex);
    }
    const metadata = new Map(
      [...tokens.metadata].map(([address, value]) => [
        address.toLowerCase(),
        value,
      ]),
    );
    const assetLabels = new Map(
      [...(diagram.assetLabels ?? [])].map(([address, label]) => [
        address.toLowerCase(),
        label,
      ]),
    );
    const tokenNet = new Map<string, string[]>();
    const balances = new TokenBalanceReader().read(context.evidence.calls);
    const tokenReferences: {
      holder: string;
      asset: string;
      rawNet: string;
      logs: number[];
      balance?: ObservedTokenBalance;
    }[] = [];
    for (const [holder, assets] of totals) {
      for (const [asset, total] of assets) {
        if (total.amount === 0n) continue;
        const label = assetLabels.get(asset);
        if (!label) throw new Error("Missing asset presentation label.");
        const decimals = metadata.get(asset)?.decimals;
        const quantity =
          decimals === undefined
            ? `${total.amount} units`
            : formatUnits(total.amount, decimals);
        const holderLabel = holderName(holder);
        const values = tokenNet.get(holderLabel) ?? [];
        const balance = balances.get(balanceKey(asset, holder));
        const percentage = balance
          ? balancePercentage(total.amount, BigInt(balance.amount))
          : undefined;
        values.push(
          `${total.amount > 0n ? "+" : ""}${quantity} ${displayText(label)}${percentage ? ` (${percentage})` : ""}`,
        );
        tokenNet.set(holderLabel, values);
        tokenReferences.push({
          holder,
          asset,
          rawNet: total.amount.toString(),
          logs: [...new Set(total.logs)],
          ...(balance ? { balance } : {}),
        });
      }
    }
    const state = new Map<string, OutcomeDocument["decoded_state"][string]>();
    const stateReferences: {
      contract: string;
      field: string;
      changeId: string;
    }[] = [];
    let omitted = 0;
    for (const change of context.display.storage.changes) {
      if (!decoded(change)) {
        omitted++;
        continue;
      }
      const contract = name(change.contract);
      const field = displayText(
        change.name.replace(/\[([^\]]+)\]/g, (match, key: string) =>
          [...aliases.values()].includes(key) ? `[${name(key)}]` : match,
        ),
      );
      const value = (value: string | boolean) =>
        typeof value === "boolean"
          ? value
          : /^(?:address|contract\b)/.test(change.type) &&
              [...aliases.values()].includes(value)
            ? name(value)
            : displayText(value);
      const changes = state.get(contract) ?? [];
      changes.push({
        field,
        type: displayText(change.type),
        before: value(change.before),
        after: value(change.after),
      });
      state.set(contract, changes);
      stateReferences.push({ contract, field, changeId: change.id });
    }
    const document: OutcomeDocument = {
      version: 1,
      chain: context.evidence.identity.chain,
      status: context.evidence.calls.find((call) => call.parentId === null)
        ?.reverted
        ? "reverted"
        : "success",
      token_net_from_transfers: Object.fromEntries(tokenNet),
      decoded_state: Object.fromEntries(state),
    };
    return {
      document,
      yaml: stringify(document, { lineWidth: 0 }),
      diagnostics: {
        coverage: {
          tokens: "ERC-20 events; balances not independently verified",
          state_diff: context.display.storage.status,
          omitted_state_changes: omitted,
        },
        identity: context.evidence.identity,
        tokenReferences,
        stateReferences,
        names: [...names],
      },
    };
  }
}

function decoded(change: StorageChange): change is StorageChange & {
  type: string;
  before: string | boolean;
  after: string | boolean;
} {
  return (
    typeof change.type === "string" &&
    (typeof change.before === "string" || typeof change.before === "boolean") &&
    (typeof change.after === "string" || typeof change.after === "boolean")
  );
}
