import { mkdir, open, unlink, rmdir, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { toHex } from "viem";
import { chains, parseChain } from "../config/chains.js";
import { Configuration } from "../config/configuration.js";
import { hash } from "../collection/validation.js";
import { AlchemyRpcClient } from "../collection/rpc.js";
import { AlchemyTransactionCollector } from "../collection/collector.js";
import { FileCollectionCache } from "../collection/cache.js";
import { MetadataResolver } from "../metadata/resolver.js";
import { SourcifyMetadataProvider } from "../metadata/sourcify.js";
import { FileMetadataStore } from "../metadata/store.js";
import { HistoricalCodeMatcher } from "../decoding/binding.js";
import { TransactionDecoder } from "../decoding/decoder.js";
import {
  StandardTokenInterpreter,
  RpcTokenMetadataReader,
} from "../interpretation/tokens.js";
import {
  D2SequenceRenderer,
  validateImageOptions,
} from "../rendering/renderer.js";
import { TransactionPipeline, reportFiles } from "./transaction.js";

interface PipelineSettings {
  chain: ReturnType<typeof parseChain>;
  envFile: string | undefined;
  cacheDirectory: string;
  metadataDirectory: string;
  useCache: boolean;
  cachedMetadataOnly: boolean;
}

async function createPipeline(
  settings: PipelineSettings,
): Promise<TransactionPipeline> {
  const config = await Configuration.load(
    settings.envFile ? { envFile: settings.envFile } : {},
  );
  const rpc = new AlchemyRpcClient(
    chains[settings.chain],
    config.rpcUrl(settings.chain),
  );
  const matcher = new HistoricalCodeMatcher(rpc);
  const resolver = new MetadataResolver(
    new SourcifyMetadataProvider(),
    new FileMetadataStore(settings.metadataDirectory),
  );
  return new TransactionPipeline({
    collector: new AlchemyTransactionCollector(
      rpc,
      settings.useCache
        ? new FileCollectionCache(settings.cacheDirectory)
        : undefined,
    ),
    decoder: new TransactionDecoder(
      {
        resolve: (identity) =>
          resolver.resolve(identity, { offline: settings.cachedMetadataOnly }),
      },
      matcher,
    ),
    interpreter: {
      interpret: (context) =>
        new StandardTokenInterpreter(
          new RpcTokenMetadataReader(
            rpc,
            toHex(context.evidence.identity.blockNumber),
          ),
        ).interpret(context),
    },
    renderer: new D2SequenceRenderer(),
    validateBlock: (evidence) => matcher.validateBlock(evidence),
  });
}

export async function runAnalyzeCli(
  args: string[],
  factory: (
    settings: PipelineSettings,
  ) => Promise<Pick<TransactionPipeline, "run">> = createPipeline,
): Promise<string> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      chain: { type: "string" },
      tx: { type: "string" },
      output: { type: "string" },
      "env-file": { type: "string" },
      "no-state-diff": { type: "boolean" },
      "no-cache": { type: "boolean" },
      "cache-dir": { type: "string" },
      "metadata-dir": { type: "string" },
      "cached-metadata-only": { type: "boolean" },
      quality: { type: "string" },
      scale: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    return "Usage: invariant-monitor analyze --chain <ethereum|base> --tx <hash> --output <new-directory> [--no-state-diff] [--no-cache] [--cache-dir <path>] [--metadata-dir <path>] [--cached-metadata-only] [--env-file <path>] [--quality 90] [--scale 1]\n";
  if (!values.chain || !values.tx || !values.output)
    throw new Error("Specify --chain, --tx and --output.");
  const chain = parseChain(values.chain);
  const transactionHash = hash(values.tx);
  const image = {
    quality: Number(values.quality ?? 90),
    scale: Number(values.scale ?? 1),
  };
  validateImageOptions(image);
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const files: {
    name: (typeof reportFiles)[number];
    path: string;
    handle: FileHandle;
  }[] = [];
  let completed = false;
  try {
    for (const name of reportFiles) {
      const path = join(output, name);
      files.push({ name, path, handle: await open(path, "wx") });
    }
    const pipeline = await factory({
      chain,
      envFile: values["env-file"],
      cacheDirectory: values["cache-dir"] ?? ".cache/collections",
      metadataDirectory: values["metadata-dir"] ?? ".cache/metadata",
      useCache: !values["no-cache"],
      cachedMetadataOnly: values["cached-metadata-only"] ?? false,
    });
    const result = await pipeline.run(
      { chain, transactionHash },
      { includeStateDiff: !values["no-state-diff"], image },
      (stage) => process.stderr.write(`${stage}...\n`),
    );
    for (const file of files) await file.handle.writeFile(result[file.name]);
    completed = true;
    return `Saved ${join(output, "sequence.jpg")}\nSaved ${join(output, "outcomes.yaml")}\nEvidence and diagnostics: ${output}\n`;
  } finally {
    await Promise.all(files.map((file) => file.handle.close()));
    if (!completed) {
      await Promise.all(files.map((file) => unlink(file.path)));
      await rmdir(output).catch((error) => {
        if (error?.code !== "ENOTEMPTY") throw error;
      });
    }
  }
}
