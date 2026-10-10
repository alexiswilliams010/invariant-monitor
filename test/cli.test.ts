import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const loader = import.meta.resolve("tsx");

test("CLI checks both chains without a dotenv file and never prints credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "invariant-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const chain of ["ethereum", "base"]) {
    const result = await execute(
      process.execPath,
      ["--import", loader, cli, "check-config", "--chain", chain],
      {
        cwd: directory,
        env: { ALCHEMY_API_KEY: "synthetic-private-key" },
      },
    );
    assert.match(result.stdout, /configuration ready/);
    assert.match(result.stdout, /RPC access not checked/);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes("synthetic-private-key"));
  }
});

test("CLI exits unsuccessfully when credentials are missing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "invariant-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    execute(
      process.execPath,
      ["--import", loader, cli, "check-config", "--chain", "base"],
      { cwd: directory, env: {} },
    ),
    (error: Error & { code?: number; stderr?: string }) =>
      error.code === 1 && /Set ALCHEMY_API_KEY/.test(error.stderr ?? ""),
  );
});
