import type { SequenceNode } from "../decoding/compression.js";
import type { DiagramInput } from "./sequence.js";

export class StaticCallFilter {
  filter(input: DiagramInput): DiagramInput {
    const visit = (
      nodes: readonly SequenceNode[],
      readOnly = false,
    ): SequenceNode[] =>
      nodes.flatMap((node): SequenceNode[] => {
        if (node.kind === "repeat") {
          const body = visit(node.body, readOnly);
          return body.length ? [{ ...node, body }] : [];
        }
        const call = input.calls.get(node.callId)!;
        const staticContext = readOnly || call.kind === "STATICCALL";
        const children = visit(node.children, staticContext);
        if (
          staticContext &&
          !call.reverted &&
          !call.assetMovement &&
          call.parentId !== null &&
          !children.length
        )
          return [];
        return [{ ...node, children }];
      });
    return { ...input, sequence: visit(input.sequence) };
  }
}
