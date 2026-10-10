import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { chains, type ChainName } from "./chains.js";

export interface ConfigurationOptions {
  readonly envFile?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export class Configuration {
  readonly #apiKey: string;

  private constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  static async load(
    options: ConfigurationOptions = {},
  ): Promise<Configuration> {
    const environment = options.environment ?? process.env;
    let fileEnvironment: Readonly<NodeJS.ProcessEnv> = {};
    try {
      const content = await readFile(options.envFile ?? ".env", "utf8");
      fileEnvironment = parseEnv(content);
    } catch (error) {
      const missing =
        error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!missing || options.envFile !== undefined) {
        throw new Error("Cannot read the environment file.");
      }
    }

    const apiKey = (
      environment.ALCHEMY_API_KEY ?? fileEnvironment.ALCHEMY_API_KEY
    )?.trim();
    if (!apiKey) {
      throw new Error("Set ALCHEMY_API_KEY in .env or the environment.");
    }
    return new Configuration(apiKey);
  }

  rpcUrl(chain: ChainName): string {
    return `${chains[chain].alchemyBaseUrl}/${encodeURIComponent(this.#apiKey)}`;
  }
}
