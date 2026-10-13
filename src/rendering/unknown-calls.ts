import type { SequenceNode } from "../decoding/compression.js";
import type { DiagramCall, DiagramInput } from "./sequence.js";

export class UnknownCallFilter {
  filter(input: DiagramInput): DiagramInput {
    const root = input.sequence.find((node) => node.kind === "call");
    const initiator = root ? input.calls.get(root.callId)!.from : undefined;
    const protectedCalls = new Set<string>();
    const context = (call: DiagramCall) => call.storageContext ?? call.to;
    const inspect = (
      nodes: readonly SequenceNode[],
      ancestors: readonly DiagramCall[],
    ) => {
      for (const node of nodes) {
        if (node.kind === "repeat") {
          inspect(node.body, ancestors);
          continue;
        }
        const call = input.calls.get(node.callId)!;
        if (call.assetMovement) continue;
        const previous = ancestors.findLastIndex(
          (ancestor) => context(ancestor) === context(call),
        );
        if (
          previous >= 0 &&
          ancestors
            .slice(previous + 1)
            .some((ancestor) => context(ancestor) !== context(call))
        ) {
          for (const ancestor of ancestors.slice(previous))
            protectedCalls.add(ancestor.id);
          protectedCalls.add(call.id);
        }
        inspect(node.children, [...ancestors, call]);
      }
    };
    inspect(input.sequence, []);
    const visit = (nodes: readonly SequenceNode[]): SequenceNode[] =>
      nodes.flatMap((node): SequenceNode[] => {
        if (node.kind === "repeat") {
          const body = visit(node.body);
          return body.length ? [{ ...node, body }] : [];
        }
        const call = input.calls.get(node.callId)!;
        const children = visit(node.children);
        if (
          call.action === "call" &&
          call.from !== initiator &&
          call.parentId !== null &&
          !call.assetMovement &&
          !protectedCalls.has(call.id) &&
          ["CALL", "STATICCALL", "DELEGATECALL", "CALLCODE"].includes(call.kind)
        )
          return children;
        return [{ ...node, children }];
      });
    return { ...input, sequence: visit(input.sequence) };
  }
}
