import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { AlchemyRpcClient } from "../collection/rpc.js";
import { chains } from "../config/chains.js";
import { Configuration } from "../config/configuration.js";
import { MetadataResolver } from "../metadata/resolver.js";
import { SourcifyMetadataProvider } from "../metadata/sourcify.js";
import { FileMetadataStore } from "../metadata/store.js";
import { HistoricalCodeMatcher } from "./binding.js";
import { TransactionDecoder } from "./decoder.js";
import { readEvidence } from "./evidence.js";

export async function runDecodeCli(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "metadata-dir": { type: "string" },
      "env-file": { type: "string" },
      "cached-metadata-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    return "Usage: invariant-monitor decode --input <evidence.json> --output <display.json> [--metadata-dir <path>] [--cached-metadata-only] [--env-file <path>]\n";
  if (!values.input || !values.output)
    throw new Error("Specify --input and --output for decoding.");
  const evidence = readEvidence(
    JSON.parse(await readFile(values.input, "utf8")),
  );
  const config = await Configuration.load(
    values["env-file"] ? { envFile: values["env-file"] } : {},
  );
  await mkdir(dirname(values.output), { recursive: true });
  const file = await open(values.output, "wx");
  const diagnosticPath = `${values.output}.diagnostics.json`;
  let diagnostics;
  let completed = false;
  try {
    diagnostics = await open(diagnosticPath, "wx");
    const resolver = new MetadataResolver(
      new SourcifyMetadataProvider(),
      new FileMetadataStore(values["metadata-dir"] ?? ".cache/metadata"),
    );
    const metadata = {
      resolve: (identity: Parameters<MetadataResolver["resolve"]>[0]) =>
        resolver.resolve(identity, {
          offline: values["cached-metadata-only"] ?? false,
        }),
    };
    const rpc = new AlchemyRpcClient(
      chains[evidence.identity.chain],
      config.rpcUrl(evidence.identity.chain),
    );
    const result = await new TransactionDecoder(
      metadata,
      new HistoricalCodeMatcher(rpc),
    ).decode(evidence);
    await file.writeFile(JSON.stringify(result.display, null, 2) + "\n");
    await diagnostics.writeFile(
      JSON.stringify(result.diagnostics, null, 2) + "\n",
    );
    completed = true;
    const count = result.diagnostics.decoding.filter(
      (call) => call.status === "decoded",
    ).length;
    return `Decoded arguments for ${count}/${evidence.calls.length} calls.\nSaved ${values.output}\nDiagnostics ${diagnosticPath}\n`;
  } finally {
    await file.close();
    await diagnostics?.close();
    if (!completed) {
      await unlink(values.output);
      if (diagnostics) await unlink(diagnosticPath);
    }
  }
}
