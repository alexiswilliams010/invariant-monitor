import { formatUnits, type Address } from "viem";
import type { InterpretationContext } from "./types.js";
import type { TokenInterpretation, TokenMovement } from "./tokens.js";
import {
  readDiagram,
  type DiagramCall,
  type DiagramInput,
} from "../rendering/sequence.js";
import type { SequenceNode } from "../decoding/compression.js";
import { chains } from "../config/chains.js";
import { displayText } from "../decoding/presentation.js";

export class AssetFlowProjector {
  project(
    context: InterpretationContext,
    tokens: TokenInterpretation,
  ): DiagramInput {
    const input = readDiagram(context.display);
    const calls = new Map(input.calls);
    const names = new Map(
      context.addresses.map((entry) => [
        entry.address.toLowerCase(),
        entry.name,
      ]),
    );
    const used = new Set(names.values());
    const synthetic = new Map<string, string>();
    const name = (address: Address | null, fallback: string): string => {
      if (address === null) {
        if (!synthetic.has(fallback)) {
          let label = fallback;
          let suffix = 2;
          while (used.has(label)) label = `${fallback}_${suffix++}`;
          used.add(label);
          synthetic.set(fallback, label);
        }
        return synthetic.get(fallback)!;
      }
      const key = address.toLowerCase();
      if (!names.has(key)) {
        let next = `Holder_${names.size + 1}`;
        while (used.has(next)) next += "_2";
        used.add(next);
        names.set(key, next);
      }
      return names.get(key)!;
    };
    const labels = new Map<Address, string>();
    const preferredNames = new Map<string, string>();
    const taken = new Set<string>();
    for (const asset of tokens.metadata.keys()) {
      const base = displayText(
        tokens.metadata.get(asset)?.symbol ?? `Asset_${labels.size + 1}`,
      );
      let label = base;
      let suffix = 2;
      while (taken.has(label)) label = `${base}_${suffix++}`;
      taken.add(label);
      labels.set(asset, label);
      if (tokens.metadata.get(asset)?.symbol)
        preferredNames.set(name(asset, "Asset"), label);
    }
    const movementCall = (
      movement: TokenMovement,
      id: string,
      parentId: string | null,
    ): DiagramCall => {
      const decimals = tokens.metadata.get(movement.asset)?.decimals;
      const quantity =
        decimals === undefined
          ? `${movement.amount} units`
          : formatUnits(BigInt(movement.amount), decimals);
      return {
        id,
        parentId,
        from: name(movement.from, "Mint"),
        to: name(movement.to, "Burn"),
        storageContext: null,
        kind: "CALL",
        valueWei: "0",
        reverted: false,
        action: `${quantity} ${labels.get(movement.asset)!}`,
        assetMovement: true,
      };
    };
    const placed = new Set<number>();
    const hidden = new Set(tokens.hiddenReadIds);
    const byCall = new Map(
      tokens.movements
        .filter((m) => m.candidateCallId)
        .map((m) => [m.candidateCallId!, m]),
    );
    const visit = (
      nodes: readonly SequenceNode[],
      repeated = false,
    ): SequenceNode[] =>
      nodes.flatMap((node): SequenceNode[] => {
        if (node.kind === "repeat")
          return [{ ...node, body: visit(node.body, true) }];
        // A representative loop does not carry every iteration's amount; retain its calls.
        const movement = repeated ? undefined : byCall.get(node.callId);
        if (movement) {
          calls.set(
            node.callId,
            movementCall(
              movement,
              node.callId,
              calls.get(node.callId)!.parentId,
            ),
          );
          placed.add(movement.logIndex);
          return [{ ...node, children: [] }];
        }
        if (!repeated && hidden.has(node.callId)) return [];
        const raw = context.evidence.calls.find(
          (call) => call.id === node.callId,
        )!;
        if (
          !repeated &&
          !node.children.length &&
          !raw.reverted &&
          raw.type === "CALL" &&
          raw.input === "0x" &&
          raw.value !== "0"
        ) {
          const currency =
            chains[context.evidence.identity.chain].nativeCurrency;
          const existing = calls.get(node.callId)!;
          calls.set(node.callId, {
            ...existing,
            assetMovement: true,
            action:
              formatUnits(BigInt(raw.value), currency.decimals) +
              " " +
              currency.symbol,
          });
          return [node];
        }
        return [{ ...node, children: visit(node.children, repeated) }];
      });
    const sequence = visit(input.sequence);
    const unplacedMovements = tokens.movements
      .filter((m) => !placed.has(m.logIndex) && BigInt(m.amount) !== 0n)
      .map((m) => {
        const id = `movement:${m.logIndex}`;
        calls.set(id, movementCall(m, id, null));
        return id;
      });
    return {
      calls,
      sequence,
      unplacedMovements,
      preferredNames,
      assetLabels: labels,
      addressNames: names,
    };
  }
}
