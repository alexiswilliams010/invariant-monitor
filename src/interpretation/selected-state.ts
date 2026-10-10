import type {
  ContractTarget,
  InterpretationAdapter,
  InterpretationContext,
  InterpretationResult,
} from "./types.js";

export class SelectedStateAdapter implements InterpretationAdapter {
  readonly scope;
  private readonly fields: ReadonlySet<string> | undefined;

  constructor(
    readonly id: string,
    target: ContractTarget,
    fields?: readonly string[],
  ) {
    this.scope = { kind: "contract", ...target } as const;
    this.fields = fields === undefined ? undefined : new Set(fields);
  }

  async interpret(
    context: InterpretationContext,
  ): Promise<InterpretationResult> {
    const name =
      context.evidence.identity.chainId === this.scope.chainId
        ? context.addresses.find(
            (item) =>
              item.address.toLowerCase() === this.scope.address.toLowerCase(),
          )?.name
        : undefined;
    if (!name) return { status: "not-applicable", facts: [] };
    if (context.display.storage.status !== "collected")
      return { status: "unavailable", facts: [] };
    const changes = context.display.storage.changes.filter(
      (change) =>
        change.contract === name &&
        (!this.fields || this.fields.has(change.name)),
    );
    return {
      status: "interpreted",
      facts: changes.map((change) => ({
        kind: "contract-state-change",
        contract: this.scope.address,
        change,
        evidence: {
          basis: "state-observed",
          position: { kind: "transaction" },
          references: [{ kind: "storage", changeId: change.id }],
        },
      })),
    };
  }
}
