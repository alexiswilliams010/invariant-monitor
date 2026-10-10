import type {
  DecisionsClient,
  DecisionsRequest,
  DecisionsResponse,
} from "./types.js";
import { validateResponse } from "./validation.js";

export const vercelDecisionsEndpoint =
  "https://ai-gateway.vercel.sh/v1/decisions";

export class HttpDecisionsClient implements DecisionsClient {
  readonly #apiKey: string;
  constructor(
    apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly endpoint = vercelDecisionsEndpoint,
    private readonly timeoutMs = 120_000,
  ) {
    if (!apiKey.trim())
      throw new Error("Set AI_GATEWAY_API_KEY in .env or the environment.");
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Decisions endpoint must be an HTTPS URL without credentials, query, or fragment.",
      );
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Decisions timeout must be a positive integer.");
    this.#apiKey = apiKey.trim();
  }

  async decide(request: DecisionsRequest): Promise<DecisionsResponse> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    let body: unknown;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        redirect: "error",
        signal,
      });
      if (response.ok) body = await response.json();
      else await response.body?.cancel();
    } catch {
      throw new Error(
        signal.aborted
          ? "Decisions request timed out; it may have been processed. No retry was made."
          : "Decisions request failed or returned unreadable JSON. No retry was made.",
      );
    }
    if (!response.ok)
      throw new Error(
        `Decisions API returned HTTP ${response.status}. No retry was made.`,
      );
    return validateResponse(body, request.questions);
  }
}
