import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvironment } from "../config/environment.js";
import { HttpDecisionsClient } from "./client.js";
import { DecisionReport } from "./report.js";
import type { DecisionsClient, ImageDetail } from "./types.js";
import { parseQuestions } from "./validation.js";

const help = `Usage: invariant-monitor decide --report <analyze-directory> --questions <questions.json>
  --model <provider/model> --output <new-json-file> [--dry-run]
  [--detail low|high|auto|original] [--env-file <path>]

Sends outcomes.yaml and sequence.jpg to Vercel's Decisions API.
--dry-run saves the exact request without credentials or network access.
Live requests require AI_GATEWAY_API_KEY; use an image-capable Decisions model.
`;

export async function runDecideCli(
  args: string[],
  createClient: (key: string) => DecisionsClient = (key) =>
    new HttpDecisionsClient(key),
): Promise<string> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        report: { type: "string" },
        questions: { type: "string" },
        model: { type: "string" },
        output: { type: "string" },
        detail: { type: "string", default: "high" },
        "env-file": { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch {
    throw new Error("Invalid decide arguments. Use decide --help.");
  }
  if (values.help) return help;
  if (
    !values.report ||
    !values.questions ||
    !values.model?.trim() ||
    !values.output
  )
    throw new Error("Specify --report, --questions, --model, and --output.");
  if (!["low", "high", "auto", "original"].includes(values.detail))
    throw new Error("Invalid image --detail.");
  let input: unknown;
  try {
    input = JSON.parse(await readFile(values.questions, "utf8"));
  } catch {
    throw new Error("Cannot read questions JSON.");
  }
  const questions = parseQuestions(input);
  const report = await DecisionReport.load(values.report);
  const request = report.request(
    values.model.trim(),
    questions,
    values.detail as ImageDetail,
  );
  await mkdir(dirname(values.output), { recursive: true });
  const file = await open(values.output, "wx");
  let completed = false;
  try {
    let result: unknown = request;
    if (!values["dry-run"]) {
      const environment = await loadEnvironment(
        values["env-file"] === undefined ? {} : { envFile: values["env-file"] },
      );
      const key = environment.AI_GATEWAY_API_KEY?.trim();
      if (!key)
        throw new Error("Set AI_GATEWAY_API_KEY in .env or the environment.");
      const started = performance.now();
      const response = await createClient(key).decide(request);
      result = {
        version: 1,
        requestedModel: request.model,
        questions,
        detail: values.detail,
        inputs: report.fingerprints(),
        requestSha256: createHash("sha256")
          .update(JSON.stringify(request))
          .digest("hex"),
        durationMs: Math.round(performance.now() - started),
        response,
      };
    }
    await file.writeFile(JSON.stringify(result, null, 2) + "\n");
    completed = true;
    return `${values["dry-run"] ? "Prepared request; no network call made" : "Decisions response received"}. Saved ${values.output}\n`;
  } finally {
    await file.close();
    if (!completed) await unlink(values.output);
  }
}
