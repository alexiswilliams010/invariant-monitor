import { loadEnvironment, type EnvironmentOptions } from "./environment.js";
import { chains, type ChainName } from "./chains.js";

export type ConfigurationOptions = EnvironmentOptions;

export class Configuration {
  readonly #apiKey: string;

  private constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  static async load(
    options: ConfigurationOptions = {},
  ): Promise<Configuration> {
    const environment = await loadEnvironment(options);
    const apiKey = environment.ALCHEMY_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Set ALCHEMY_API_KEY in .env or the environment.");
    }
    return new Configuration(apiKey);
  }

  rpcUrl(chain: ChainName): string {
    return `${chains[chain].alchemyBaseUrl}/${encodeURIComponent(this.#apiKey)}`;
  }
}
