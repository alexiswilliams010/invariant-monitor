import type { DisplayArgument } from "../decoding/presentation.js";
import { displayText } from "../decoding/presentation.js";
import type { InterpretationContext } from "./types.js";

type ArgumentValue =
  string | boolean | ArgumentValue[] | { [key: string]: ArgumentValue };

export interface CallContextFact {
  caller: string;
  via?: string[];
  contract: string;
  code?: string;
  function: string;
  arguments: Record<string, ArgumentValue>;
  reverted?: true;
}

export function callContextFacts(
  context: InterpretationContext,
  name: (alias: string) => string,
) {
  const raw = new Map(context.evidence.calls.map((call) => [call.id, call]));
  const aliases = new Map(
    context.addresses.map((entry) => [entry.address.toLowerCase(), entry.name]),
  );
  const effective = new Map<string, string>();
  const sender = (id: string): string => {
    const cached = effective.get(id);
    if (cached) return cached;
    const call = raw.get(id);
    if (!call) throw new Error("Missing call context evidence.");
    const address =
      call.type === "DELEGATECALL" && call.parentId !== null
        ? sender(call.parentId)
        : call.type === "CALLCODE" && call.parentId !== null
          ? (raw.get(call.parentId)?.storageContext ?? call.from)
          : call.from;
    effective.set(id, address);
    return address;
  };
  const namedAddress = (address: string) => {
    const alias = aliases.get(address.toLowerCase());
    if (!alias) throw new Error("Missing call context address name.");
    return name(alias);
  };
  const via = (id: string): string[] => {
    const path: string[] = [];
    let parentId = raw.get(id)?.parentId;
    const current = raw.get(id)?.storageContext;
    while (parentId) {
      const parent = raw.get(parentId);
      if (!parent) throw new Error("Missing call context parent.");
      if (
        parent.type !== "DELEGATECALL" &&
        parent.type !== "CALLCODE" &&
        parent.storageContext
      )
        path.unshift(parent.storageContext);
      parentId = parent.parentId;
    }
    if (
      path.at(-1) === current &&
      ["DELEGATECALL", "CALLCODE"].includes(raw.get(id)!.type)
    )
      path.pop();
    return path.map(namedAddress);
  };
  const argumentsOf = (
    args: readonly DisplayArgument[],
  ): Record<string, ArgumentValue> =>
    Object.fromEntries(
      args.map((arg, index) => {
        const label =
          arg.name &&
          args.filter((other) => other.name === arg.name).length === 1
            ? arg.name
            : `arg${index + 1}`;
        let value: ArgumentValue = arg.type;
        if (typeof arg.value === "boolean") value = arg.value;
        else if (typeof arg.value === "string")
          value =
            arg.type === "address" ? name(arg.value) : displayText(arg.value);
        else if (arg.value) value = argumentsOf(arg.value);
        return [`${displayText(label)} (${displayText(arg.type)})`, value];
      }),
    );
  const depths = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const call = raw.get(id);
    if (!call) throw new Error("Missing call context evidence.");
    const value =
      call.parentId === null
        ? 0
        : depth(call.parentId) +
          (call.type === "DELEGATECALL" || call.type === "CALLCODE" ? 0 : 1);
    depths.set(id, value);
    return value;
  };
  const selected = context.display.calls.filter(
    (call) => depth(call.id) <= 1 && (call.parentId === null || !call.readOnly),
  );
  const root = context.evidence.calls.find((call) => call.parentId === null);
  const facts: CallContextFact[] = [];
  const references: { index: number; callId: string }[] = [];
  for (const call of selected) {
    const path = via(call.id);
    facts.push({
      caller: namedAddress(sender(call.id)),
      ...(path.length ? { via: path } : {}),
      contract: name(call.storageContext ?? call.to),
      ...(call.storageContext !== null && call.storageContext !== call.to
        ? { code: name(call.to) }
        : {}),
      function: displayText(call.action),
      arguments: argumentsOf(call.args),
      ...(call.reverted ? { reverted: true as const } : {}),
    });
    references.push({ index: facts.length - 1, callId: call.id });
  }
  return {
    initiator: root ? namedAddress(root.from) : "unknown",
    calls: facts,
    references,
  };
}
