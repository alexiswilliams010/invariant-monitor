import {
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { isAddress, toHex } from "viem";
import { AlchemyRpcClient } from "../collection/rpc.js";
import { Configuration } from "../config/configuration.js";
import { chains } from "../config/chains.js";
import { readEvidence } from "../decoding/evidence.js";
import { CallSequenceCompressor } from "../decoding/compression.js";
import type { ExecutionDisplay } from "../decoding/decoder.js";
import { readDiagram } from "../rendering/sequence.js";
import { D2SequenceRenderer } from "../rendering/renderer.js";
import { StandardTokenInterpreter, RpcTokenMetadataReader } from "./tokens.js";
import { AssetFlowProjector } from "./asset-view.js";
import { array, object } from "../collection/validation.js";
import { OutcomeExporter } from "./outcomes.js";

export async function runFlowCli(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      input: { type: "string" },
      display: { type: "string" },
      output: { type: "string" },
      offline: { type: "boolean" },
      "env-file": { type: "string" },
      quality: { type: "string" },
      scale: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help)
    return "Usage: invariant-monitor flow --input <evidence.json> --display <display.json> --output <prefix> [--offline] [--quality 90] [--scale 1]\n";
  if (!values.input || !values.display || !values.output)
    throw new Error("Specify --input, --display and --output.");
  const evidence = readEvidence(
    JSON.parse(await readFile(values.input, "utf8")),
  );
  const display = JSON.parse(
    await readFile(values.display, "utf8"),
  ) as ExecutionDisplay;
  readDiagram(display);
  const diagnostics = object(
    JSON.parse(await readFile(`${values.display}.diagnostics.json`, "utf8")),
    "diagnostics",
  );
  const identity = object(diagnostics.identity, "diagnostic identity");
  if (
    Object.entries(evidence.identity).some(
      ([key, value]) => identity[key] !== value,
    )
  )
    throw new Error("Evidence and display identities differ.");
  const addresses = array(diagnostics.addresses, "addresses").map((value) => {
    const entry = object(value, "address name");
    if (
      typeof entry.address !== "string" ||
      !isAddress(entry.address, { strict: false }) ||
      typeof entry.name !== "string"
    )
      throw new Error("Invalid address name.");
    return { address: entry.address, name: entry.name };
  });
  const aliases = new Map(
    addresses.map((entry) => [entry.address.toLowerCase(), entry.name]),
  );
  if (
    aliases.size !== addresses.length ||
    new Set(addresses.map((entry) => entry.name)).size !== addresses.length
  )
    throw new Error("Address aliases must be unique.");
  if (
    display.calls.length !== evidence.calls.length ||
    evidence.calls.some(
      (call) =>
        !display.calls.some(
          (item) =>
            item.id === call.id &&
            item.kind === call.type &&
            item.reverted === call.reverted &&
            item.from === aliases.get(call.from) &&
            item.to === (call.to ? aliases.get(call.to) : "contract") &&
            item.storageContext ===
              (call.storageContext ? aliases.get(call.storageContext) : null),
        ),
    )
  )
    throw new Error("Evidence and display calls differ.");
  const context = {
    evidence,
    display: {
      ...display,
      sequence: new CallSequenceCompressor().compress(evidence.calls).sequence,
    },
    addresses,
  };
  await mkdir(dirname(values.output), { recursive: true });
  const files: { path: string; handle: FileHandle }[] = [];
  let completed = false;
  try {
    for (const extension of ["d2", "svg", "jpg", "diagnostics.json", "yaml"]) {
      const path = `${values.output}.${extension}`;
      files.push({ path, handle: await open(path, "wx") });
    }
    let reader: RpcTokenMetadataReader | undefined;
    let rpc: AlchemyRpcClient | undefined;
    if (!values.offline) {
      const config = await Configuration.load(
        values["env-file"] ? { envFile: values["env-file"] } : {},
      );
      rpc = new AlchemyRpcClient(
        chains[evidence.identity.chain],
        config.rpcUrl(evidence.identity.chain),
      );
      const chainId = await rpc.request({ method: "eth_chainId" });
      const block = await rpc.request({
        method: "eth_getBlockByNumber",
        params: [toHex(evidence.identity.blockNumber), false],
      });
      if (
        Number(BigInt(chainId)) !== evidence.identity.chainId ||
        block?.hash !== evidence.identity.blockHash
      )
        throw new Error("Historical token metadata chain/block mismatch.");
      reader = new RpcTokenMetadataReader(
        rpc,
        toHex(evidence.identity.blockNumber),
      );
    }
    const tokens = await new StandardTokenInterpreter(reader).interpret(
      context,
    );
    if (rpc) {
      const block = await rpc.request({
        method: "eth_getBlockByNumber",
        params: [toHex(evidence.identity.blockNumber), false],
      });
      if (block?.hash !== evidence.identity.blockHash)
        throw new Error("Block changed during metadata lookup.");
    }
    const projection = new AssetFlowProjector().project(context, tokens);
    const result = await new D2SequenceRenderer().render(projection, {
      quality: Number(values.quality ?? 90),
      scale: Number(values.scale ?? 1),
    });
    const outcomes = new OutcomeExporter().build(
      context,
      tokens,
      projection,
      result.names,
    );
    await files[0]!.handle.writeFile(result.source);
    await files[1]!.handle.writeFile(result.svg);
    await files[2]!.handle.writeFile(result.jpeg);
    await files[3]!.handle.writeFile(
      JSON.stringify(
        {
          schemaVersion: 1,
          identity: evidence.identity,
          basis: "event-reported",
          callAssociation: "inferred-unique-calldata-match",
          stateCorroboration: "unavailable",
          movements: tokens.movements,
          metadata: [...tokens.metadata],
          hiddenReadIds: tokens.hiddenReadIds,
          unplacedMovements: projection.unplacedMovements,
          outcomes: outcomes.diagnostics,
        },
        null,
        2,
      ),
    );
    await files[4]!.handle.writeFile(outcomes.yaml);
    completed = true;
    return `Rendered ${result.width} × ${result.height}: ${tokens.movements.length} reported token movements, ${projection.unplacedMovements?.length ?? 0} without call placement.\nSaved ${values.output}.jpg and ${values.output}.yaml\n`;
  } finally {
    await Promise.all(files.map((file) => file.handle.close()));
    if (!completed) await Promise.all(files.map((file) => unlink(file.path)));
  }
}
