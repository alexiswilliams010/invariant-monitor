import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { chains } from "../src/config/chains.js";
import { AlchemyRpcClient, RpcFailure } from "../src/collection/rpc.js";

test("RPC failures discard provider messages and authenticated URLs", async (t) => {
  const secret = "synthetic-private-key";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const { id } = JSON.parse(body) as { id: number };
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Provider echoed ${secret}` },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const rpc = new AlchemyRpcClient(
    chains.ethereum,
    `http://127.0.0.1:${bound.port}/${secret}`,
  );
  await assert.rejects(
    rpc.request({ method: "eth_chainId" }),
    (error: unknown) => {
      assert.ok(error instanceof RpcFailure);
      assert.equal(error.code, -32601);
      assert.equal(error.cause, undefined);
      assert.ok(!String(error.stack).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    },
  );
  assert.equal(rpc.measurements.length, 1);
  assert.equal(rpc.measurements[0]?.succeeded, false);
});
