export type Question = {
  readonly name?: string;
  readonly instructions: string;
} & (
  | { readonly type: "predicate" }
  | {
      readonly type: "choice";
      readonly choices: readonly {
        readonly value: string | boolean;
        readonly description?: string;
      }[];
    }
  | {
      readonly type: "score";
      readonly levels: readonly {
        readonly label: string;
        readonly description?: string;
      }[];
    }
);

export type ImageDetail = "auto" | "low" | "high" | "original";

export interface DecisionsRequest {
  readonly model: string;
  readonly input: readonly {
    readonly role: "user";
    readonly content: readonly (
      | { readonly type: "input_text"; readonly text: string }
      | {
          readonly type: "input_image";
          readonly image_url: string;
          readonly detail: ImageDetail;
        }
    )[];
  }[];
  readonly questions: readonly Question[];
}

export type DecisionAnswer = { readonly name: string | null } & (
  | { readonly type: "refusal" }
  | { readonly type: "predicate"; readonly probability: number }
  | {
      readonly type: "choice";
      readonly choice: string | boolean;
      readonly confidence?: number;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly confidence?: number;
    }
);

export interface DecisionsResponse {
  readonly model: string;
  readonly answers: readonly DecisionAnswer[];
  readonly usage?: unknown;
  readonly provider_metadata?: unknown;
}

export interface DecisionsClient {
  decide(request: DecisionsRequest): Promise<DecisionsResponse>;
}
