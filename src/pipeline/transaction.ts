import type {
  TransactionCollector,
  TransactionEvidence,
  TransactionRequest,
} from "../collection/types.js";
import type { TransactionDecoder } from "../decoding/decoder.js";
import type { InterpretationContext } from "../interpretation/types.js";
import type { TokenInterpretation } from "../interpretation/tokens.js";
import { AssetFlowProjector } from "../interpretation/asset-view.js";
import { OutcomeExporter } from "../interpretation/outcomes.js";
import type {
  D2SequenceRenderer,
  ImageOptions,
} from "../rendering/renderer.js";

export interface PipelineComponents {
  collector: TransactionCollector;
  decoder: Pick<TransactionDecoder, "decode">;
  interpreter: {
    interpret(context: InterpretationContext): Promise<TokenInterpretation>;
  };
  renderer: Pick<D2SequenceRenderer, "render">;
  validateBlock(evidence: TransactionEvidence): Promise<void>;
}

export const reportFiles = [
  "evidence.json",
  "decoded.json",
  "decoded.json.diagnostics.json",
  "sequence.d2",
  "sequence.svg",
  "sequence.jpg",
  "outcomes.yaml",
  "interpretation.diagnostics.json",
] as const;
export type ReportFiles = Record<
  (typeof reportFiles)[number],
  string | Uint8Array
>;
export type PipelineStage = "collect" | "decode" | "interpret" | "render";

export class TransactionPipeline {
  constructor(
    private readonly components: PipelineComponents,
    private readonly projector = new AssetFlowProjector(),
    private readonly exporter = new OutcomeExporter(),
  ) {}

  async run(
    request: TransactionRequest,
    options: { includeStateDiff: boolean; image: ImageOptions },
    progress: (stage: PipelineStage) => void = () => {},
  ): Promise<ReportFiles> {
    progress("collect");
    const evidence = await this.components.collector.collect(request, {
      includeStateDiff: options.includeStateDiff,
    });
    progress("decode");
    const decoded = await this.components.decoder.decode(evidence);
    const context = {
      evidence,
      display: decoded.display,
      addresses: decoded.diagnostics.addresses,
    };
    progress("interpret");
    const tokens = await this.components.interpreter.interpret(context);
    await this.components.validateBlock(evidence);
    const projection = this.projector.project(context, tokens);
    progress("render");
    const rendered = await this.components.renderer.render(
      projection,
      options.image,
    );
    const outcomes = this.exporter.build(
      context,
      tokens,
      projection,
      rendered.names,
    );
    return {
      "evidence.json": json(evidence),
      "decoded.json": json(decoded.display),
      "decoded.json.diagnostics.json": json(decoded.diagnostics),
      "sequence.d2": rendered.source,
      "sequence.svg": rendered.svg,
      "sequence.jpg": rendered.jpeg,
      "outcomes.yaml": outcomes.yaml,
      "interpretation.diagnostics.json": json({
        schemaVersion: 1,
        identity: evidence.identity,
        basis: "event-reported",
        callAssociation: "inferred-unique-calldata-match",
        stateCorroboration: "unavailable",
        movements: tokens.movements,
        metadata: [...tokens.metadata],
        hiddenReadIds: tokens.hiddenReadIds,
        unplacedMovements: projection.unplacedMovements,
        image: {
          stage: rendered.stage,
          baselineRows: rendered.baselineRows,
          rows: rendered.rows,
          width: rendered.width,
          height: rendered.height,
          scale: rendered.scale,
          quality: rendered.quality,
          bytes: rendered.jpeg.length,
        },
        outcomes: outcomes.diagnostics,
      }),
    };
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
