import { array, object } from "../collection/validation.js";
import type { SequenceNode } from "../decoding/compression.js";
import { displayText } from "../decoding/presentation.js";
import { ForwardingCollapser } from "./forwarding.js";
import { StaticCallFilter } from "./static-calls.js";
import { ParticipantNameResolver } from "./names.js";

export interface DiagramCall {
  id: string;
  parentId: string | null;
  from: string;
  to: string;
  storageContext: string | null;
  assetMovement?: boolean;
  action: string;
  kind: string;
  valueWei: string;
  reverted: boolean;
}

export interface DiagramInput {
  readonly preferredNames?: ReadonlyMap<string, string>;
  readonly unplacedMovements?: readonly string[];
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
      storageContext:
        item.storageContext === null ? null : text(item.storageContext),
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
    const names = new ParticipantNameResolver().resolve(original);
    const forwarded = new ForwardingCollapser().collapse(
      new StaticCallFilter().filter(original),
    );
    const omitSelfCalls = (nodes: readonly SequenceNode[]): SequenceNode[] =>
      nodes.flatMap((node): SequenceNode[] => {
        if (node.kind === "repeat") {
          const body = omitSelfCalls(node.body);
          return body.length ? [{ ...node, body }] : [];
        }
        const call = forwarded.calls.get(node.callId)!;
        const children = omitSelfCalls(node.children);
        if (
          call.from === call.to &&
          !call.assetMovement &&
          ["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"].includes(call.kind)
        )
          return children;
        return [{ ...node, children }];
      });
    const input = { ...forwarded, sequence: omitSelfCalls(forwarded.sequence) };
    const participants = new Map<string, { id: string; label: string }>();
    const labels = new Set<string>();
    const targetKey = (call: DiagramCall) =>
      call.to === "contract" &&
      (call.kind === "CREATE" || call.kind === "CREATE2")
        ? `creation:${call.id}`
        : call.to;
    const register = (key: string, label: string) => {
      if (participants.has(key)) return;
      const base = names.get(key) ?? label;
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
    for (const id of original.unplacedMovements ?? []) {
      const call = input.calls.get(id)!;
      register(call.from, call.from);
      register(targetKey(call), call.to);
    }
    const lines = ["shape: sequence_diagram", "style.fill: white"];
    for (const { id, label } of participants.values())
      lines.push(
        `${id}: ${quote(label)} {shape: text; style.font-size: 20; style.font-color: "#172033"}`,
      );
    let group = 0;
    const emit = (nodes: readonly SequenceNode[], count = 1) => {
      for (const node of nodes) {
        if (node.kind === "repeat") {
          if (
            node.body.length === 1 &&
            node.body[0]?.kind === "call" &&
            !node.body[0].children.length
          ) {
            emit(node.body, node.count);
            continue;
          }
          lines.push(
            `g${group++}: "Repeat ×${node.count}" {`,
            'style.fill: "#f1f5f9"; style.stroke: "#52677c"; style.stroke-width: 2; style.font-size: 20',
          );
          emit(node.body);
          lines.push("}");
          continue;
        }
        const call = input.calls.get(node.callId)!;
        const from = participants.get(call.from)!.id;
        const to = participants.get(targetKey(call))!.id;
        const label =
          call.action +
          (!call.assetMovement && call.kind === "CALL" && call.valueWei !== "0"
            ? ` · ${call.valueWei} wei`
            : "") +
          (count > 1 ? ` ×${count}` : "") +
          (call.reverted ? " · revert" : "");
        const color = call.reverted
          ? "#b91c1c"
          : call.assetMovement
            ? "#047857"
            : "#334e68";
        lines.push(
          `${from} -> ${to}: ${quote(label)} {style.font-size: 20; style.font-color: "${color}"; style.stroke: "${color}"; style.stroke-width: 2}`,
        );
        emit(node.children);
        if (!call.assetMovement && call.kind !== "SELFDESTRUCT")
          lines.push(
            `${to} -> ${from}: "" {style.stroke-dash: 4; style.stroke: "#64748b"; style.stroke-width: 1}`,
          );
      }
    };
    emit(input.sequence);
    if (original.unplacedMovements?.length) {
      lines.push(
        'unplaced: "Reported transfers · call position unknown" {style.fill: "#f0fdf4"; style.font-size: 18',
      );
      emit(
        original.unplacedMovements.map((callId) => ({
          kind: "call",
          callId,
          children: [],
        })),
      );
      lines.push("}");
    }

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
