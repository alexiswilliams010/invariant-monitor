import type {
  InterpretationAdapter,
  InterpretationContext,
  InterpretationDocument,
} from "./types.js";

export class TransactionInterpreter {
  private readonly adapters: readonly InterpretationAdapter[];

  constructor(adapters: readonly InterpretationAdapter[]) {
    const ids = adapters.map((adapter) => adapter.id);
    if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
      throw new Error(
        "Interpretation adapter IDs must be nonempty and unique.",
      );
    this.adapters = [...adapters];
  }

  async interpret(
    context: InterpretationContext,
  ): Promise<InterpretationDocument> {
    const interpretations: InterpretationDocument["interpretations"][number][] =
      [];
    for (const adapter of this.adapters) {
      if (adapter.scope.kind === "contract") {
        const scope = adapter.scope;
        if (
          scope.chainId !== context.evidence.identity.chainId ||
          !context.addresses.some(
            (item) =>
              item.address.toLowerCase() === scope.address.toLowerCase(),
          )
        )
          continue;
      }
      const result = await adapter.interpret(context);
      if (result.status !== "interpreted" && result.facts.length)
        throw new Error("Unresolved interpretation must not emit facts.");
      if (result.facts.some((fact) => !fact.evidence.references.length))
        throw new Error("Interpreted facts require supporting evidence.");
      interpretations.push({ adapterId: adapter.id, ...result });
    }
    return {
      schemaVersion: 1,
      identity: context.evidence.identity,
      interpretations,
    };
  }
}
