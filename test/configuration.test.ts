import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";
import { Configuration } from "../src/config/configuration.js";
import { parseChain } from "../src/config/chains.js";
import { runCli } from "../src/cli.js";

test("loads quoted dotenv credentials without mutating the environment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "invariant-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env");
  await writeFile(envFile, 'ALCHEMY_API_KEY="test-file-key"\n');
  const environment = {};
  const config = await Configuration.load({ envFile, environment });
  assert.deepEqual(environment, {});
  assert.equal(
    config.rpcUrl("ethereum"),
    "https://eth-mainnet.g.alchemy.com/v2/test-file-key",
  );
  assert.equal(
    config.rpcUrl("base"),
    "https://base-mainnet.g.alchemy.com/v2/test-file-key",
  );
  assert.ok(!inspect(config).includes("test-file-key"));
  assert.ok(!JSON.stringify(config).includes("test-file-key"));
});

test("environment overrides the file, including an explicitly empty key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "invariant-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env");
  await writeFile(envFile, "ALCHEMY_API_KEY=file-key\n");
  const config = await Configuration.load({
    envFile,
    environment: { ALCHEMY_API_KEY: "env-key" },
  });
  assert.ok(config.rpcUrl("base").endsWith("/env-key"));
  await assert.rejects(
    Configuration.load({ envFile, environment: { ALCHEMY_API_KEY: " " } }),
    /Set ALCHEMY_API_KEY/,
  );
});

test("an explicit missing environment file fails even with a configured key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "invariant-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    Configuration.load({
      envFile: join(directory, "missing"),
      environment: { ALCHEMY_API_KEY: "test-key" },
    }),
    /Cannot read/,
  );
});

test("rejects unsupported chains and inherited object properties", () => {
  assert.equal(parseChain("base"), "base");
  for (const chain of ["sepolia", "constructor", "__proto__"]) {
    assert.throws(() => parseChain(chain), /Chain must be/);
  }
});

test("CLI help needs no credentials and rejects incomplete commands", async () => {
  assert.match(await runCli(["--help"]), /check-config/);
  await assert.rejects(runCli(["check-config"]), /Specify --chain/);
  await assert.rejects(runCli(["analyze"]), /Expected check-config/);
  await assert.rejects(
    runCli(["--unknown", "private-value"]),
    (error: Error) => !error.message.includes("private-value"),
  );
});
