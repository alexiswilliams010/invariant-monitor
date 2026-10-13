import { array, object } from "../collection/validation.js";
import type { SequenceNode } from "../decoding/compression.js";
import { displayText } from "../decoding/presentation.js";
import { ForwardingCollapser } from "./forwarding.js";
import { StaticCallFilter } from "./static-calls.js";
import { ParticipantNameResolver } from "./names.js";
import { compactAssetLabel } from "./amounts.js";
import { UnknownCallFilter } from "./unknown-calls.js";

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
  readonly assetLabels?: ReadonlyMap<string, string>;
  readonly addressNames?: ReadonlyMap<string, string>;
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

export interface DiagramSimplificationOptions {
  readonly mode?: "auto" | "always" | "never";
  readonly rowThreshold?: number;
}

export class SequenceDiagramBuilder {
  constructor(private readonly options: DiagramSimplificationOptions = {}) {
    if (
      !Number.isSafeInteger(options.rowThreshold ?? 250) ||
      (options.rowThreshold ?? 250) < 0
    )
      throw new Error("Diagram row threshold must be a nonnegative integer.");
  }
  build(original: DiagramInput): string {
    return this.buildDocument(original).source;
  }

  buildDocument(original: DiagramInput) {
    const detailed = this.buildVariant(original, false, false);
    if (this.options.mode === "never") return detailed;
    if (this.options.mode === "always")
      return this.buildVariant(original, true, true);
    const threshold = this.options.rowThreshold ?? 250;
    if (detailed.rows <= threshold) return detailed;
    const compact = this.buildVariant(original, true, false);
    return compact.rows <= threshold
      ? compact
      : this.buildVariant(original, true, true);
  }

  private buildVariant(
    original: DiagramInput,
    simplified: boolean,
    filterUnknown: boolean,
  ) {
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
    const baseline = {
      ...forwarded,
      sequence: omitSelfCalls(forwarded.sequence),
    };
    const countRows = (nodes: readonly SequenceNode[]): number =>
      nodes.reduce((total, node) => {
        if (node.kind === "repeat") return total + countRows(node.body);
        const call = baseline.calls.get(node.callId)!;
        return (
          total +
          (call.assetMovement || call.kind === "SELFDESTRUCT" ? 1 : 2) +
          countRows(node.children)
        );
      }, 0);
    const baselineRows = countRows(baseline.sequence);
    const input = filterUnknown
      ? new UnknownCallFilter().filter(baseline)
      : baseline;
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
    const lines = ["shape: sequence_diagram", "style.fill: white"];
    for (const { id, label } of participants.values())
      lines.push(
        `${id}: ${quote(label)} {shape: text; style.font-size: 20; style.font-color: "#172033"}`,
      );
    let group = 0;
    const emit = (nodes: readonly SequenceNode[], count = 1) => {
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
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
        const actions = [
          simplified && call.assetMovement
            ? compactAssetLabel(call.action)
            : call.action,
        ];
        if (simplified && call.assetMovement && !node.children.length) {
          while (index + 1 < nodes.length) {
            const next = nodes[index + 1]!;
            if (next.kind !== "call" || next.children.length) break;
            const candidate = input.calls.get(next.callId)!;
            if (
              !candidate.assetMovement ||
              candidate.from !== call.from ||
              candidate.to !== call.to ||
              candidate.parentId !== call.parentId ||
              candidate.reverted !== call.reverted
            )
              break;
            actions.push(compactAssetLabel(candidate.action));
            index++;
          }
        }
        const label =
          actions.join("\n") +
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
        const arrow =
          simplified && !call.assetMovement && call.kind !== "SELFDESTRUCT"
            ? "<->"
            : "->";
        lines.push(
          `${from} ${arrow} ${to}: ${quote(label)} {style.font-size: 20; style.font-color: "${color}"; style.stroke: "${color}"; style.stroke-width: 2}`,
        );
        emit(node.children);
        if (!simplified && !call.assetMovement && call.kind !== "SELFDESTRUCT")
          lines.push(
            `${to} -> ${from}: "" {style.stroke-dash: 4; style.stroke: "#64748b"; style.stroke-width: 1}`,
          );
      }
    };
    emit(input.sequence);

    return {
      baselineRows,
      simplified,
      stage: filterUnknown ? "filtered" : simplified ? "compact" : "detailed",
      rows: lines.filter((line) => /^p\d+ (?:->|<->) p\d+:/.test(line)).length,
      source: lines.join("\n") + "\n",
      names: new Map(
        [...participants].map(([key, value]) => [key, value.label]),
      ),
    };
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.length)
    throw new Error("Invalid display text.");
  return value;
}

function quote(value: string): string {
  return JSON.stringify(
    value
      .split("\n")
      .map((line) => displayText(line).replaceAll("$", "＄"))
      .join("\n"),
  );
}
