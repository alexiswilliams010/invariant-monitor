#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { chains, parseChain } from "./config/chains.js";
import { Configuration } from "./config/configuration.js";

const help = `Usage: invariant-monitor check-config --chain <ethereum|base> [--env-file <path>]

Check local configuration without making network requests.
Environment variables override values in .env.
`;

export async function runCli(args: string[]): Promise<string> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        chain: { type: "string" },
        "env-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    throw new Error("Invalid arguments. Use --help for usage.");
  }
  if (parsed.values.help || args.length === 0) return help;
  if (
    parsed.positionals.length !== 1 ||
    parsed.positionals[0] !== "check-config"
  ) {
    throw new Error("Expected check-config. Use --help for usage.");
  }
  if (typeof parsed.values.chain !== "string") {
    throw new Error("Specify --chain ethereum or --chain base.");
  }
  const chain = parseChain(parsed.values.chain);
  const envFile = parsed.values["env-file"];
  await Configuration.load(typeof envFile === "string" ? { envFile } : {});
  return `${chains[chain].name} (${chains[chain].id}): configuration ready. RPC access not checked.\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(await runCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Command failed."}\n`,
    );
    process.exitCode = 1;
  }
}
