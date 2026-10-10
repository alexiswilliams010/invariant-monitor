import { array, object } from "../collection/validation.js";
import type { SequenceNode } from "../decoding/compression.js";
import { displayText } from "../decoding/presentation.js";
import { ForwardingCollapser } from "./forwarding.js";

interface DiagramCall {
  id: string;
  parentId: string | null;
  from: string;
  to: string;
  storageContext: string;
  action: string;
  kind: string;
  valueWei: string;
  reverted: boolean;
}

export interface DiagramInput {
  readonly calls: ReadonlyMap<string, DiagramCall>;
  readonly sequence: readonly SequenceNode[];
}

export function readDiagram(value: unknown): DiagramInput {
  const input = object(value, "display");
  if (input.schemaVersion !== 3)
    throw new Error("Rendering requires display schema version 3.");
  const calls = new Map<string, DiagramCall>();
  for (const value of array(input.calls, "display calls")) {
    const item = object(value, "display call");
    const id = text(item.id);
    if (calls.has(id)) throw new Error("Duplicate display call ID.");
    const kind = text(item.kind);
    if (
      ![
        "CALL",
        "STATICCALL",
        "DELEGATECALL",
        "CALLCODE",
        "CREATE",
        "CREATE2",
        "SELFDESTRUCT",
      ].includes(kind)
    )
      throw new Error("Invalid call kind.");
    const valueWei = text(item.valueWei);
    if (
      !/^(0|[1-9][0-9]*)$/.test(valueWei) ||
      typeof item.reverted !== "boolean"
    )
      throw new Error("Invalid call value or outcome.");
    calls.set(id, {
      id,
      parentId: item.parentId === null ? null : text(item.parentId),
      from: text(item.from),
      to: text(item.to),
      storageContext: text(item.storageContext),
      action: text(item.action),
      kind,
      valueWei,
      reverted: item.reverted,
    });
  }
  const seen = new Set<string>();
  const repeats = new Set<string>();
  const parse = (
    values: unknown,
    parent: string | null,
    depth: number,
  ): SequenceNode[] => {
    if (depth > 256)
      throw new Error("Sequence nesting exceeds rendering limit.");
    return array(values, "sequence").map((value): SequenceNode => {
      const node = object(value, "sequence node");
      if (node.kind === "call") {
        const id = text(node.callId);
        const call = calls.get(id);
        if (!call || call.parentId !== parent || seen.has(id))
          throw new Error("Sequence call reference mismatch.");
        seen.add(id);
        return {
          kind: "call",
          callId: id,
          children: parse(node.children, id, depth + 1),
        };
      }
      if (
        node.kind !== "repeat" ||
        typeof node.count !== "number" ||
        !Number.isSafeInteger(node.count) ||
        node.count < 2 ||
        typeof node.diffArgs !== "boolean" ||
        typeof node.diffReturns !== "boolean"
      )
        throw new Error("Invalid repeat block.");
      const id = text(node.id);
      if (repeats.has(id)) throw new Error("Duplicate repeat ID.");
      repeats.add(id);
      const body = parse(node.body, parent, depth + 1);
      if (!body.length) throw new Error("Empty repeat body.");
      return {
        kind: "repeat",
        id,
        count: node.count,
        diffArgs: node.diffArgs,
        diffReturns: node.diffReturns,
        body,
      };
    });
  };
  const sequence = parse(input.sequence, null, 0);
  if (sequence.length !== 1 || sequence[0]?.kind !== "call")
    throw new Error("Sequence must have one root call.");
  return { calls, sequence };
}

export class SequenceDiagramBuilder {
  build(original: DiagramInput): string {
    const input = new ForwardingCollapser().collapse(original);
    const participants = new Map<string, { id: string; label: string }>();
    const labels = new Set<string>();
    const targetKey = (call: DiagramCall) =>
      call.to === "contract" &&
      (call.kind === "CREATE" || call.kind === "CREATE2")
        ? `creation:${call.id}`
        : call.to;
    const register = (key: string, label: string) => {
      if (participants.has(key)) return;
      const base = input.names.get(key) ?? label;
      let name = base;
      let suffix = 2;
      while (labels.has(name)) name = `${base}_${suffix++}`;
      labels.add(name);
      participants.set(key, { id: `p${participants.size}`, label: name });
    };
    const visit = (nodes: readonly SequenceNode[]) => {
      for (const node of nodes) {
        if (node.kind === "repeat") visit(node.body);
        else {
          const call = input.calls.get(node.callId)!;
          register(call.from, call.from);
          register(targetKey(call), call.to);
          visit(node.children);
        }
      }
    };
    visit(input.sequence);
    const lines = ["grid-columns: 1", "vertical-gap: 12", "style.fill: white"];
    let row = 0;
    let group = 0;
    const emit = (nodes: readonly SequenceNode[], indent: string) => {
      for (const node of nodes) {
        if (node.kind === "repeat") {
          const label = [
            `x${node.count}`,
            ...(node.diffArgs ? ["diff args"] : []),
            ...(node.diffReturns ? ["diff returns"] : []),
          ].join(" · ");
          lines.push(
            `${indent}g${group++}: ${quote(label)} {`,
            `${indent}  style.fill: "#f1f5f9"`,
            `${indent}  grid-columns: 1; vertical-gap: 12; style.font-size: 20`,
          );
          emit(node.body, `${indent}  `);
          lines.push(`${indent}}`);
          continue;
        }
        const call = input.calls.get(node.callId)!;
        const label = `${call.action}${call.valueWei !== "0" && call.kind === "CALL" ? ` · ${call.valueWei} wei` : ""}${call.reverted ? " · revert" : ""}`;
        const stroke = call.reverted ? "#b91c1c" : "#334155";
        lines.push(
          `${indent}r${row++}: "" {`,
          `${indent}  grid-columns: 2; horizontal-gap: 340`,
          `${indent}  style.stroke-width: 0; style.fill: transparent`,
          `${indent}  a: ${quote(participants.get(call.from)!.label)} {shape: text; width: 250; style.font-size: 20}`,
          `${indent}  b: ${quote(participants.get(targetKey(call))!.label)} {shape: text; width: 250; style.font-size: 20}`,
          `${indent}  a -> b: ${quote(label)} {style.stroke: "${stroke}"; style.font-color: "#111827"; style.font-size: 20}`,
          `${indent}}`,
        );
        emit(node.children, indent);
      }
    };
    emit(input.sequence, "");
    return lines.join("\n") + "\n";
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.length)
    throw new Error("Invalid display text.");
  return value;
}

function quote(value: string): string {
  return JSON.stringify(displayText(value).replaceAll("$", "＄"));
}
