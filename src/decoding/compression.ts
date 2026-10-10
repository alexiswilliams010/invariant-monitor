import { createHash } from "node:crypto";
import type { CallFrame } from "../collection/types.js";

export type SequenceNode =
  | {
      readonly kind: "call";
      readonly callId: string;
      readonly children: readonly SequenceNode[];
    }
  | {
      readonly kind: "repeat";
      readonly id: string;
      readonly count: number;
      readonly diffArgs: boolean;
      readonly diffReturns: boolean;
      readonly body: readonly SequenceNode[];
    };

export interface RepeatEvidence {
  readonly id: string;
  readonly iterations: readonly (readonly string[])[];
}

interface Tree {
  frame: CallFrame;
  children: Tree[];
  signature: string;
  frames: readonly CallFrame[];
  view: SequenceNode;
}

export class CallSequenceCompressor {
  constructor(private readonly maxPatternLength = 32) {
    if (
      !Number.isSafeInteger(maxPatternLength) ||
      maxPatternLength < 1 ||
      maxPatternLength > 256
    )
      throw new Error("Compression pattern limit must be between 1 and 256.");
  }

  compress(calls: readonly CallFrame[]): {
    sequence: readonly SequenceNode[];
    repeats: readonly RepeatEvidence[];
  } {
    const root = buildTree(calls);
    const repeats = new Map<string, RepeatEvidence>();
    const prepare = (tree: Tree): void => {
      for (const child of tree.children) prepare(child);
      tree.frames = [
        tree.frame,
        ...tree.children.flatMap((child) => child.frames),
      ];
      const call = tree.frame;
      const lifecycle =
        call.type === "CREATE" ||
        call.type === "CREATE2" ||
        call.type === "SELFDESTRUCT";
      tree.signature = createHash("sha256")
        .update(
          JSON.stringify([
            call.from,
            call.to,
            call.storageContext,
            call.type,
            call.input.slice(0, 10),
            call.value,
            call.reverted,
            call.readOnly,
            lifecycle ? call.id : null,
            tree.children.map((child) => child.signature),
          ]),
        )
        .digest("hex");
      tree.view = {
        kind: "call",
        callId: call.id,
        children: this.group(tree.children, repeats),
      };
    };
    prepare(root);
    const used: RepeatEvidence[] = [];
    const visit = (node: SequenceNode): void => {
      if (node.kind === "repeat") {
        used.push(repeats.get(node.id)!);
        node.body.forEach(visit);
      } else node.children.forEach(visit);
    };
    visit(root.view);
    return { sequence: [root.view], repeats: used };
  }

  private group(
    siblings: readonly Tree[],
    repeats: Map<string, RepeatEvidence>,
  ): readonly SequenceNode[] {
    const result: SequenceNode[] = [];
    for (let start = 0; start < siblings.length;) {
      let best: { width: number; count: number; saved: number } | undefined;
      for (
        let width = 1;
        width <=
        Math.min(
          this.maxPatternLength,
          Math.floor((siblings.length - start) / 2),
        );
        width++
      ) {
        let count = 1;
        while (
          start + (count + 1) * width <= siblings.length &&
          siblings
            .slice(start, start + width)
            .every(
              (node, offset) =>
                node.signature ===
                siblings[start + count * width + offset]!.signature,
            )
        )
          count++;
        if (count < 2) continue;
        const saved =
          siblings
            .slice(start, start + width)
            .reduce((sum, node) => sum + node.frames.length, 0) *
          (count - 1);
        if (!best || saved > best.saved) best = { width, count, saved };
      }
      if (!best) {
        result.push(siblings[start++]!.view);
        continue;
      }
      const { width, count } = best;
      const iterations = Array.from({ length: count }, (_, i) =>
        siblings
          .slice(start + i * width, start + (i + 1) * width)
          .flatMap((node) => node.frames),
      );
      const first = iterations[0]!;
      const id = `repeat:${first[0]!.id}:${width}`;
      const differs = (field: "input" | "output") =>
        iterations
          .slice(1)
          .some((iteration) =>
            iteration.some((call, i) => call[field] !== first[i]![field]),
          );
      result.push({
        kind: "repeat",
        id,
        count,
        diffArgs: differs("input"),
        diffReturns: differs("output"),
        body: siblings.slice(start, start + width).map((node) => node.view),
      });
      repeats.set(id, {
        id,
        iterations: iterations.map((iteration) =>
          iteration.map((call) => call.id),
        ),
      });
      start += width * count;
    }
    return result;
  }
}

function buildTree(calls: readonly CallFrame[]): Tree {
  let root: Tree | undefined;
  const stack: Tree[] = [];
  const ids = new Set<string>();
  for (const frame of calls) {
    if (ids.has(frame.id))
      throw new Error("Duplicate call ID in compression input.");
    ids.add(frame.id);
    const node: Tree = {
      frame,
      children: [],
      signature: "",
      frames: [],
      view: { kind: "call", callId: frame.id, children: [] },
    };
    if (frame.parentId === null) {
      if (root) throw new Error("Compression requires one call root.");
      root = node;
    } else {
      while (stack.length && stack.at(-1)!.frame.id !== frame.parentId)
        stack.pop();
      if (!stack.length)
        throw new Error("Invalid call preorder for compression.");
      stack.at(-1)!.children.push(node);
    }
    stack.push(node);
  }
  if (!root) throw new Error("Compression requires a call root.");
  return root;
}
