import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { address } from "../collection/validation.js";
import { chains, parseChain } from "../config/chains.js";
import { MetadataResolver } from "./resolver.js";
import { SourcifyMetadataProvider } from "./sourcify.js";
import { FileMetadataStore } from "./store.js";

export async function runMetadataCli(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      chain: { type: "string" },
      address: { type: "string" },
      output: { type: "string" },
      offline: { type: "boolean" },
      refresh: { type: "boolean" },
      "cache-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    return "Usage: invariant-monitor metadata --chain <ethereum|base> --address <address> --output <path> [--offline | --refresh] [--cache-dir <path>]\n";
  const chain = parseChain(values.chain ?? "");
  const identity = {
    chainId: chains[chain].id,
    address: address(values.address, "contract address"),
  };
  if (!values.output) throw new Error("Specify --output for metadata.");
  if (values.offline && values.refresh)
    throw new Error("Offline mode cannot refresh metadata.");
  await mkdir(dirname(values.output), { recursive: true });
  const file = await open(values.output, "wx");
  let completed = false;
  try {
    const resolver = new MetadataResolver(
      new SourcifyMetadataProvider(),
      new FileMetadataStore(values["cache-dir"] ?? ".cache/metadata"),
    );
    const result = await resolver.resolve(identity, {
      offline: values.offline ?? false,
      refresh: values.refresh ?? false,
    });
    if (result.status === "unavailable") throw new Error(result.reason);
    await file.writeFile(
      JSON.stringify({ schemaVersion: 1, identity, ...result }, null, 2) + "\n",
    );
    completed = true;
    return `${chains[chain].name}: metadata ${result.status}.\nSaved ${values.output}\n`;
  } finally {
    await file.close();
    if (!completed) await unlink(values.output);
  }
}
