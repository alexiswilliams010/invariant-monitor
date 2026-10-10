import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import sharp from "sharp";
import {
  HttpDecisionsClient,
  vercelDecisionsEndpoint,
} from "../src/decisions/client.js";
import { runDecideCli } from "../src/decisions/cli.js";
import { DecisionReport } from "../src/decisions/report.js";
import {
  parseQuestions,
  validateResponse,
} from "../src/decisions/validation.js";
import type { DecisionsRequest } from "../src/decisions/types.js";

const questions = parseQuestions([
  {
    type: "predicate",
    name: "loss",
    instructions: "Is there a negative token movement?",
  },
  {
    type: "choice",
    instructions: "Select an answer.",
    choices: [{ value: true }, { value: false }],
  },
  {
    type: "score",
    name: "scale",
    instructions: "Choose a level.",
    levels: [{ label: "low" }, { label: "high" }],
  },
]);
const response = {
  model: "provider/actual-model",
  answers: [
    { type: "predicate", name: "loss", probability: 0.9 },
    {
      type: "choice",
      name: null,
      choice: true,
      confidence: 0.8,
      probabilities: [
        { value: true, probability: 0.8 },
        { value: false, probability: 0.2 },
      ],
    },
    { type: "score", name: "scale", score: 0.5 },
  ],
  usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
  provider_metadata: { gateway: { cost: "0.01" } },
} as const;
const request: DecisionsRequest = {
  model: "provider/requested",
  input: [],
  questions,
};

test("questions reject typos, duplicate names, ambiguous choices, and invalid bounds", () => {
  for (const invalid of [
    [],
    {},
    [{ type: "predicate", instructions: "" }],
    [...questions, questions[0]],
    [{ type: "predicate", instructions: "x", instruction: "typo" }],
    [
      {
        type: "choice",
        instructions: "x",
        choices: [{ value: true }, { value: "true" }],
      },
    ],
    [{ type: "score", instructions: "x", levels: [{ label: "one" }] }],
  ]) {
    assert.throws(() => parseQuestions(invalid));
  }
  assert.equal(parseQuestions(questions).length, 3);
});

test("responses retain metadata and refusals and reject mismatched or invalid answers", () => {
  assert.equal(validateResponse(response, questions), response);
  assert.doesNotThrow(() =>
    validateResponse(
      {
        ...response,
        answers: [
          { type: "refusal", name: "loss" },
          ...response.answers.slice(1),
        ],
      },
      questions,
    ),
  );
  for (const answer of [
    { type: "predicate", name: "wrong", probability: 0.5 },
    { type: "predicate", name: "loss", probability: 1.1 },
    { type: "choice", name: "loss", choice: true },
  ]) {
    assert.throws(() =>
      validateResponse(
        { ...response, answers: [answer, ...response.answers.slice(1)] },
        questions,
      ),
    );
  }
  assert.throws(() =>
    validateResponse({ ...response, answers: [] }, questions),
  );
  assert.throws(() =>
    validateResponse(
      {
        ...response,
        answers: [
          response.answers[0],
          { type: "choice", name: null, choice: "true" },
          response.answers[2],
        ],
      },
      questions,
    ),
  );
});

test("HTTP client sends the exact request and keeps credentials private", async () => {
  let calls = 0;
  const client = new HttpDecisionsClient(
    "secret-test-key",
    async (url, options) => {
      calls++;
      assert.equal(url, vercelDecisionsEndpoint);
      assert.equal(options?.method, "POST");
      assert.equal(options?.redirect, "error");
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        "Bearer secret-test-key",
      );
      assert.deepEqual(JSON.parse(String(options?.body)), request);
      return Response.json(response);
    },
  );
  assert.deepEqual(await client.decide(request), response);
  assert.equal(calls, 1);
  assert.ok(!inspect(client).includes("secret-test-key"));
  assert.ok(!JSON.stringify(client).includes("secret-test-key"));
});

test("HTTP errors and transport errors omit provider bodies and are never retried", async () => {
  for (const status of [400, 401, 429, 500]) {
    let calls = 0;
    const client = new HttpDecisionsClient("secret", async () => {
      calls++;
      return new Response("sensitive provider payload", { status });
    });
    await assert.rejects(client.decide(request), {
      message: `Decisions API returned HTTP ${status}. No retry was made.`,
    });
    assert.equal(calls, 1);
  }
  const client = new HttpDecisionsClient("secret", async () => {
    throw new Error("secret");
  });
  await assert.rejects(client.decide(request), {
    message:
      "Decisions request failed or returned unreadable JSON. No retry was made.",
  });
  const timeout = new HttpDecisionsClient(
    "secret",
    async (_url, options) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      options?.signal?.throwIfAborted();
      return Response.json(response);
    },
    vercelDecisionsEndpoint,
    1,
  );
  await assert.rejects(timeout.decide(request), /timed out/);
});

test("report CLI dry run embeds the exact JPEG and excludes evidence and credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decisions-"));
  try {
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const yaml = "version: 1\ntoken_net_from_transfers:\n  Safe: [-20 USDC]\n";
    await Promise.all([
      writeFile(join(directory, "sequence.jpg"), jpeg),
      writeFile(join(directory, "outcomes.yaml"), yaml),
      writeFile(join(directory, "evidence.json"), "do-not-send-evidence"),
      writeFile(join(directory, "questions.json"), JSON.stringify(questions)),
      writeFile(join(directory, ".env"), "AI_GATEWAY_API_KEY=local-test-key\n"),
    ]);
    const args = [
      "--report",
      directory,
      "--questions",
      join(directory, "questions.json"),
      "--model",
      "provider/model",
      "--output",
      join(directory, "request.json"),
    ];
    let calls = 0;
    const message = await runDecideCli(
      [...args, "--dry-run", "--env-file", "/missing-env"],
      () => {
        throw new Error("must not create client");
      },
    );
    assert.match(message, /no network call/);
    const payload = JSON.parse(
      await readFile(join(directory, "request.json"), "utf8"),
    );
    assert.deepEqual(payload.questions, questions);
    assert.equal(
      payload.input[0].content[1].image_url,
      `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    );
    assert.ok(payload.input[0].content[0].text.endsWith(yaml));
    assert.ok(!JSON.stringify(payload).includes("do-not-send-evidence"));
    await assert.rejects(
      runDecideCli([...args, "--env-file", join(directory, ".env")], () => {
        calls++;
        throw new Error("must not call");
      }),
      /EEXIST/,
    );
    assert.equal(calls, 0);
    const liveArgs = [
      ...args.slice(0, -1),
      join(directory, "result.json"),
      "--env-file",
      join(directory, ".env"),
    ];
    await runDecideCli(liveArgs, (key) => {
      assert.ok(key.length > 0);
      return {
        async decide(sent) {
          assert.deepEqual(sent, payload);
          return response;
        },
      };
    });
    const result = JSON.parse(
      await readFile(join(directory, "result.json"), "utf8"),
    );
    assert.deepEqual(result.response, response);
    assert.equal(result.inputs.imageSha256.length, 64);
    assert.equal(result.requestSha256.length, 64);
    assert.ok(!JSON.stringify(result).includes("local-test-key"));
    await assert.rejects(
      runDecideCli(
        [
          ...args.slice(0, -1),
          join(directory, "failure.json"),
          "--env-file",
          join(directory, ".env"),
        ],
        () => ({
          async decide() {
            throw new Error("failure");
          },
        }),
      ),
      /failure/,
    );
    assert.ok(!(await readdir(directory)).includes("failure.json"));
    await writeFile(
      join(directory, "sequence.jpg"),
      await sharp(jpeg).png().toBuffer(),
    );
    await assert.rejects(DecisionReport.load(directory), /must be a JPEG/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
