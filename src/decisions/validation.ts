import type { DecisionsResponse, Question } from "./types.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseQuestions(value: unknown): readonly Question[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Questions must be a nonempty JSON array.");
  const names = new Set<string>();
  for (const [index, question] of value.entries()) {
    const invalid = () => new Error(`Invalid question at index ${index}.`);
    if (!object(question) || !text(question.instructions)) throw invalid();
    if (question.name !== undefined) {
      if (!text(question.name) || names.has(question.name)) throw invalid();
      names.add(question.name);
    }
    const allowed = new Set(["type", "name", "instructions"]);
    if (question.type === "choice" || question.type === "score") {
      const choice = question.type === "choice";
      const key = choice ? "choices" : "levels";
      allowed.add(key);
      const entries = question[key];
      if (
        !Array.isArray(entries) ||
        entries.length < (choice ? 1 : 2) ||
        entries.length > (choice ? 255 : 10)
      )
        throw invalid();
      const values = new Set<string>();
      for (const entry of entries) {
        if (!object(entry)) throw invalid();
        const field = choice ? "value" : "label";
        const entryValue = entry[field];
        if (
          !(text(entryValue) || (choice && typeof entryValue === "boolean")) ||
          values.has(String(entryValue))
        )
          throw invalid();
        values.add(String(entryValue));
        if (
          entry.description !== undefined &&
          typeof entry.description !== "string"
        )
          throw invalid();
        if (
          Object.keys(entry).some(
            (key) => ![field, "description"].includes(key),
          )
        )
          throw invalid();
      }
    } else if (question.type !== "predicate") throw invalid();
    if (Object.keys(question).some((key) => !allowed.has(key))) throw invalid();
  }
  return value as Question[];
}

export function validateResponse(
  value: unknown,
  questions: readonly Question[],
): DecisionsResponse {
  const invalid = () =>
    new Error("Decisions API returned an invalid response.");
  if (
    !object(value) ||
    !text(value.model) ||
    !Array.isArray(value.answers) ||
    value.answers.length !== questions.length
  )
    throw invalid();
  const probability = (value: unknown) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
  for (const [index, answer] of value.answers.entries()) {
    const question = questions[index]!;
    if (!object(answer) || answer.name !== (question.name ?? null))
      throw invalid();
    if (answer.type === "refusal") continue;
    if (answer.type !== question.type) throw invalid();
    if (answer.confidence !== undefined && !probability(answer.confidence))
      throw invalid();
    if (question.type === "predicate" && !probability(answer.probability))
      throw invalid();
    if (
      question.type === "choice" &&
      !question.choices.some((choice) => choice.value === answer.choice)
    )
      throw invalid();
    if (
      question.type === "score" &&
      !(
        typeof answer.score === "number" &&
        Number.isFinite(answer.score) &&
        answer.score >= 0 &&
        answer.score <= question.levels.length - 1
      )
    )
      throw invalid();
  }
  return value as unknown as DecisionsResponse;
}
