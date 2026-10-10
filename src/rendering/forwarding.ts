import type { SequenceNode } from "../decoding/compression.js";
import type { DiagramInput } from "./sequence.js";

export class ForwardingCollapser {
  collapse(
    input: DiagramInput,
  ): DiagramInput & { names: ReadonlyMap<string, string> } {
    const calls = new Map(input.calls);
    const implementations = new Map<string, Set<string>>();
    const visit = (nodes: readonly SequenceNode[]): SequenceNode[] =>
      nodes.map((node) => {
        if (node.kind === "repeat") return { ...node, body: visit(node.body) };
        const call = calls.get(node.callId)!;
        const childNode =
          node.children.length === 1 ? node.children[0] : undefined;
        const child =
          childNode?.kind === "call" ? calls.get(childNode.callId) : undefined;
        if (
          child &&
          childNode?.kind === "call" &&
          (call.kind === "CALL" || call.kind === "STATICCALL") &&
          child.kind === "DELEGATECALL" &&
          child.from === call.to &&
          child.storageContext === call.to &&
          child.reverted === call.reverted &&
          (call.action === "call" || call.action === child.action)
        ) {
          const names = implementations.get(call.to) ?? new Set<string>();
          names.add(child.to);
          implementations.set(call.to, names);
          calls.set(call.id, { ...call, action: child.action });
          return { ...node, children: visit(childNode.children) };
        }
        return { ...node, children: visit(node.children) };
      });
    const sequence = visit(input.sequence);
    const names = new Map<string, string>();
    for (const [proxy, targets] of implementations)
      if (targets.size === 1) names.set(proxy, [...targets][0]!);
    return { calls, sequence, names };
  }
}
