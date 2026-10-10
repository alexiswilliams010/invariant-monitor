import { contractIdentity } from "./sourcify.js";
import type {
  ContractIdentity,
  MetadataProvider,
  MetadataResult,
  MetadataStore,
} from "./types.js";

export class MetadataResolver {
  constructor(
    private readonly provider: MetadataProvider,
    private readonly store: MetadataStore,
  ) {}

  async resolve(
    request: ContractIdentity,
    options: { readonly offline?: boolean; readonly refresh?: boolean } = {},
  ): Promise<MetadataResult> {
    if (options.offline && options.refresh)
      throw new Error("Offline mode cannot refresh metadata.");
    const identity = contractIdentity(request);
    if (!options.refresh) {
      const cached = await this.store.read(identity);
      if (cached) return { status: "found", metadata: cached };
    }
    if (options.offline) return { status: "offline-miss" };
    const result = await this.provider.lookup(identity);
    if (result.status === "found") await this.store.write(result.metadata);
    return result;
  }
}
