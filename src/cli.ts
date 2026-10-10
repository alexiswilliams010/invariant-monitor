#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { chains, parseChain } from "./config/chains.js";
import { Configuration } from "./config/configuration.js";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { AlchemyRpcClient } from "./collection/rpc.js";
import { AlchemyTransactionCollector } from "./collection/collector.js";
import { FileCollectionCache } from "./collection/cache.js";
import { hash } from "./collection/validation.js";
import { runMetadataCli } from "./metadata/cli.js";
import { runDecodeCli } from "./decoding/cli.js";

const help = `Usage: invariant-monitor check-config --chain <ethereum|base> [--env-file <path>]
       invariant-monitor collect --chain <ethereum|base> --tx <hash> --output <path>
         [--state-diff] [--no-cache] [--cache-dir <path>] [--env-file <path>]
       invariant-monitor metadata --chain <ethereum|base> --address <address> --output <path>
         [--offline | --refresh] [--cache-dir <path>]
       invariant-monitor decode --input <evidence.json> --output <display.json>
         [--metadata-dir <path>] [--cached-metadata-only] [--env-file <path>]

check-config checks local configuration without network requests.
collect saves raw evidence and normalized calls; output must not already exist.
State diffs are opt-in. Cache defaults to .cache/collections.
metadata looks up one contract in Sourcify; cache defaults to .cache/metadata.
Environment variables override values in .env.
`;

export async function runCli(args: string[]): Promise<string> {
  if (args[0] === "decode") return runDecodeCli(args.slice(1));
  if (args[0] === "metadata") return runMetadataCli(args.slice(1));
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
        tx: { type: "string" },
        output: { type: "string" },
        "state-diff": { type: "boolean" },
        "no-cache": { type: "boolean" },
        "cache-dir": { type: "string" },
      },
    });
  } catch {
    throw new Error("Invalid arguments. Use --help for usage.");
  }
  if (parsed.values.help || args.length === 0) return help;
  if (
    parsed.positionals.length !== 1 ||
    !["check-config", "collect"].includes(parsed.positionals[0] ?? "")
  ) {
    throw new Error("Expected check-config or collect. Use --help for usage.");
  }
  if (typeof parsed.values.chain !== "string") {
    throw new Error("Specify --chain ethereum or --chain base.");
  }
  const chain = parseChain(parsed.values.chain);
  const command = parsed.positionals[0];
  const collectionOptions = [
    "tx",
    "output",
    "state-diff",
    "no-cache",
    "cache-dir",
  ];
  if (
    command === "check-config" &&
    collectionOptions.some((key) => parsed.values[key] !== undefined)
  )
    throw new Error("Collection options require the collect command.");
  const transactionHash =
    command === "collect" ? hash(parsed.values.tx) : undefined;
  const output = parsed.values.output;
  if (
    command === "collect" &&
    (typeof output !== "string" || output.length === 0)
  )
    throw new Error("Specify --output for raw evidence.");
  const envFile = parsed.values["env-file"];
  const config = await Configuration.load(
    typeof envFile === "string" ? { envFile } : {},
  );
  if (command === "check-config")
    return `${chains[chain].name} (${chains[chain].id}): configuration ready. RPC access not checked.\n`;

  const destination = output as string;
  await mkdir(dirname(destination), { recursive: true });
  // Reserve the path before making paid requests; never overwrite a reviewed artifact.
  const file = await open(destination, "wx");
  let completed = false;
  try {
    const rpc = new AlchemyRpcClient(chains[chain], config.rpcUrl(chain));
    const cacheDirectory =
      typeof parsed.values["cache-dir"] === "string"
        ? parsed.values["cache-dir"]
        : ".cache/collections";
    const collector = new AlchemyTransactionCollector(
      rpc,
      parsed.values["no-cache"]
        ? undefined
        : new FileCollectionCache(cacheDirectory),
    );
    const evidence = await collector.collect(
      { chain, transactionHash: transactionHash! },
      { includeStateDiff: parsed.values["state-diff"] === true },
    );
    await file.writeFile(
      JSON.stringify(
        {
          ...evidence,
          collection: {
            cacheHit: collector.cacheHit,
            measurements: rpc.measurements,
          },
        },
        null,
        2,
      ) + "\n",
    );
    const timings = rpc.measurements
      .map(
        (entry) =>
          `${entry.method}: ${entry.durationMs} ms${entry.succeeded ? "" : " (failed)"}`,
      )
      .join("\n");
    completed = true;
    return `${chains[chain].name}: ${evidence.calls.length} calls; state diff ${evidence.stateDiff.status}; cache ${collector.cacheHit ? "hit" : "miss"}.\n${timings}\nSaved ${destination}\n`;
  } finally {
    await file.close();
    if (!completed) await unlink(destination);
  }
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
