import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256 } from "viem";
import { runCli } from "../src/cli.js";
import { MetadataResolver } from "../src/metadata/resolver.js";
import { SourcifyMetadataProvider } from "../src/metadata/sourcify.js";
import { FileMetadataStore } from "../src/metadata/store.js";
import type { ContractIdentity } from "../src/metadata/types.js";

const identity: ContractIdentity = {
  chainId: 1,
  address: `0x${"ab".repeat(20)}`,
};
function fixture() {
  return {
    chainId: "1",
    address: identity.address,
    match: "exact_match",
    runtimeMatch: "exact_match",
    creationMatch: null,
    matchId: "123",
    verifiedAt: "2025-01-01T00:00:00Z",
    compilation: {
      name: "Example",
      language: "Solidity",
      compiler: "solc",
      compilerVersion: "0.8.30",
    },
    deployment: {
      blockNumber: "9007199254740993",
      transactionIndex: null,
      transactionHash: null,
      deployer: null,
    },
    runtimeBytecode: { onchainBytecode: "0x6000" },
    abi: [
      {
        type: "function",
        name: "run",
        inputs: [],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ],
    storageLayout: {
      storage: [{ label: "counter", slot: "0", offset: 0, type: "t_uint256" }],
      types: {
        t_uint256: {
          encoding: "inplace",
          label: "uint256",
          numberOfBytes: "32",
        },
      },
    },
  };
}
function provider(body: unknown, status = 200) {
  return new SourcifyMetadataProvider(async () =>
    Response.json(body, { status }),
  );
}

test("Sourcify requests selective fields and retains compiler names, layouts and exact deployment numbers", async () => {
  const source = new SourcifyMetadataProvider(async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/server/v2/contract/1/${identity.address}`);
    const fields = url.searchParams.get("fields")!.split(",");
    assert.ok(fields.includes("storageLayout"));
    for (const field of ["all", "sources", "proxyResolution", "stdJsonOutput"])
      assert.ok(!fields.includes(field));
    return Response.json(fixture());
  });
  const result = await source.lookup(identity);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  assert.equal(result.metadata.compilation.name, "Example");
  assert.equal(result.metadata.deployment.blockNumber, "9007199254740993");
  assert.equal(result.metadata.runtimeCodeHash, keccak256("0x6000"));
  assert.deepEqual(result.metadata.storageLayout, fixture().storageLayout);
});

test("missing fields remain unknown; empty compiler artifacts and Vyper layouts are preserved", async () => {
  for (const layout of [
    null,
    {},
    { counter: { type: "uint256", slot: 0, n_slots: 1 } },
  ]) {
    const result = await provider({
      ...fixture(),
      compilation: { language: "Vyper" },
      deployment: null,
      abi: [],
      storageLayout: layout,
    }).lookup(identity);
    assert.equal(result.status, "found");
    if (result.status !== "found") return;
    assert.equal(result.metadata.compilation.name, null);
    assert.equal(result.metadata.deployment.blockNumber, null);
    assert.deepEqual(result.metadata.abi, []);
    assert.deepEqual(result.metadata.storageLayout, layout);
  }
});

test("not-found, HTTP failure and invalid responses stay distinct", async () => {
  const missing = {
    chainId: "1",
    address: identity.address,
    match: null,
    runtimeMatch: null,
    creationMatch: null,
  };
  assert.deepEqual(await provider(missing, 404).lookup(identity), {
    status: "not-found",
  });
  for (const [body, status] of [
    [{}, 404],
    [fixture(), 429],
    [{ ...fixture(), chainId: "8453" }, 200],
    [{ ...fixture(), runtimeMatch: "perfect" }, 200],
    [{ ...fixture(), abi: "invalid" }, 200],
  ] as const) {
    assert.equal(
      (await provider(body, status).lookup(identity)).status,
      "unavailable",
    );
  }
  const failing = new SourcifyMetadataProvider(async () => {
    throw new Error("internal details");
  });
  assert.deepEqual(await failing.lookup(identity), {
    status: "unavailable",
    reason: "Sourcify transport or timeout failure.",
  });
});

test("cache deduplicates artifacts across chains and supports offline resolution without a provider", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileMetadataStore(directory);
  const source = provider(fixture());
  const result = await new MetadataResolver(source, store).resolve(identity);
  assert.equal(result.status, "found");
  if (result.status !== "found") return;
  const base = { ...identity, chainId: 8453 };
  await store.write({ ...result.metadata, identity: base });
  assert.equal((await readdir(join(directory, "objects"))).length, 4);
  const offline = new MetadataResolver(
    {
      lookup: async () => {
        throw new Error("Unexpected network request");
      },
    },
    store,
  );
  assert.deepEqual(await offline.resolve(identity, { offline: true }), result);
  assert.equal(
    (await offline.resolve(base, { offline: true })).status,
    "found",
  );
  assert.deepEqual(
    await offline.resolve({ ...identity, chainId: 10 }, { offline: true }),
    { status: "offline-miss" },
  );
  await assert.rejects(
    offline.resolve(identity, { offline: true, refresh: true }),
    /cannot refresh/,
  );
  const pointer = JSON.parse(
    await readFile(
      join(directory, "contracts", "1", `${identity.address}.json`),
      "utf8",
    ),
  ) as { record: string };
  await writeFile(join(directory, "objects", `${pointer.record}.json`), "{}");
  await assert.rejects(store.read(identity), /corrupt/);
});

test("not-found lookups can later become verified and refresh replaces cached metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "metadata-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new FileMetadataStore(directory);
  await new MetadataResolver(
    { lookup: async () => ({ status: "not-found" }) },
    store,
  ).resolve(identity);
  assert.equal(await store.read(identity), undefined);
  const resolver = new MetadataResolver(provider(fixture()), store);
  assert.equal((await resolver.resolve(identity)).status, "found");
  const refreshed = await new MetadataResolver(
    provider({ ...fixture(), compilation: { name: "Updated" } }),
    store,
  ).resolve(identity, { refresh: true });
  assert.equal(refreshed.status, "found");
  assert.equal((await store.read(identity))?.compilation.name, "Updated");
});

test("offline metadata CLI needs no credentials and refuses to overwrite artifacts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "metadata-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output.json");
  const args = [
    "metadata",
    "--chain",
    "base",
    "--address",
    identity.address,
    "--offline",
    "--cache-dir",
    join(directory, "cache"),
    "--output",
    output,
  ];
  assert.match(await runCli(args), /offline-miss/);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    schemaVersion: 1,
    identity: { ...identity, chainId: 8453 },
    status: "offline-miss",
  });
  assert.match(await runCli(["metadata", "--help"]), /Usage:/);
  await assert.rejects(runCli(args), /EEXIST/);
});
