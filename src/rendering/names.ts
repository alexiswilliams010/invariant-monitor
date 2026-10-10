import type { DiagramInput } from "./sequence.js";

export class ParticipantNameResolver {
  resolve(input: DiagramInput): ReadonlyMap<string, string> {
    const targets = new Map<string, Set<string>>();
    for (const call of input.calls.values()) {
      if (
        call.kind !== "DELEGATECALL" ||
        call.from !== call.storageContext ||
        call.from === call.to
      )
        continue;
      const implementations = targets.get(call.from) ?? new Set<string>();
      implementations.add(call.to);
      targets.set(call.from, implementations);
    }
    const names = new Map<string, string>();
    for (const [host, implementations] of targets) {
      if (implementations.size !== 1) continue;
      const implementation = [...implementations][0]!;
      if (!/^(?:Contract_|New_Contract)[A-Z]+(?:_\d+)?$/.test(implementation))
        names.set(host, implementation);
    }
    for (const [identity, label] of input.preferredNames ?? [])
      names.set(identity, label);
    return names;
  }
}
