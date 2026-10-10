import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export interface EnvironmentOptions {
  readonly envFile?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export async function loadEnvironment(
  options: EnvironmentOptions = {},
): Promise<Readonly<NodeJS.ProcessEnv>> {
  let fileEnvironment: NodeJS.ProcessEnv = {};
  try {
    fileEnvironment = parseEnv(
      await readFile(options.envFile ?? ".env", "utf8"),
    );
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing || options.envFile !== undefined)
      throw new Error("Cannot read the environment file.");
  }
  return { ...fileEnvironment, ...(options.environment ?? process.env) };
}
