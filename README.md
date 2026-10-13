# Invariant Monitor

Turn an Ethereum or Base transaction into a readable asset-and-state summary and a sequence diagram, then optionally ask a configurable decision model whether specified invariants were broken.

Built in TypeScript with viem, Sourcify, and D2.js. Reports emphasize contract names, decoded values, and asset movements instead of raw hex. Model inference uses Vercel's Decisions API.

## Quick start

Requires Node.js 24 or newer, npm, and an Alchemy API key with access to the required trace methods.

```sh
npm ci
cp .env.example .env
```

Set `ALCHEMY_API_KEY` in `.env`. The same key serves Ethereum mainnet and Base mainnet. Add `AI_GATEWAY_API_KEY` only if you want to run model inference. Environment variables take precedence over `.env`; use `--env-file <path>` for another file.

Generate a report:

```sh
npm run dev -- analyze --chain ethereum \
  --tx 0xd29d1c8d9a1b424d4e0f472bd7b4a994028d35e9737c591eae51d917543bb854 \
  --output artifacts/example-report
```

Use `--chain base` for Base transactions. Choose a new output directory for each run. Report generation contacts Alchemy and Sourcify but does not call a model.

| Output                          | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `outcomes.yaml`                 | Asset gains/losses, initiating call context, and decoded state changes |
| `sequence.jpg`                  | Sequence diagram for people and image-capable models                   |
| `sequence.d2`, `sequence.svg`   | Diagram source and vector output                                       |
| `evidence.json`, `decoded.json` | Raw evidence and decoded execution                                     |
| `*.diagnostics.json`            | Provenance, metadata matching, and interpretation/rendering details    |

Credentials, generated reports, and caches are ignored by Git. Do not publish `.env` or credential-bearing request URLs.

## How it works

The pipeline turns provider evidence into two complementary views: a diagram of execution and a YAML summary of outcomes. Both use the same participant names and retain links to the underlying evidence in diagnostic files.

### Parse the transaction into a call tree

Alchemy supplies the transaction, receipt, block, call traces, and optional state diffs. The parser reconstructs nesting and execution order from `trace_transaction`, validates transaction/block identities, and tracks call types, native value, and reverted subtrees. Delegated execution keeps code identity separate from storage context: an implementation can execute code while changing the proxy's state. Net storage diffs remain transaction-level facts because they do not identify which call wrote each value.

### Resolve metadata and decode values

Sourcify provides available ABIs, compiler storage layouts, contract names, deployment details, and runtime bytecode. Historical code checks bind metadata to the transaction's contracts. A local content-addressed cache deduplicates identical ABIs and layouts across contracts.

ABI decoding turns selectors, calldata, and successful return data into function names and typed values. Storage decoding applies generic Solidity layout rules for packed fields, structs, arrays, and mappings. Candidate mapping keys come from participants, call data, logs, and changed storage words; attribution requires a matching slot calculation. This exposes fields such as balances, shares, or authorization mappings when metadata and evidence allow, without embedding protocol-specific decoders.

Presentation replaces addresses with available names or stable aliases, preserves exact numeric values, and reduces undecodable bytes to type labels. Raw hex and attribution details remain in evidence and diagnostics rather than overwhelming the model's inputs.

### Extract asset movements and YAML facts

A separate interpretation layer recognizes standard ERC-20 transfer events and successful native-value movements. Token symbols and decimals come from trace data or historical reads. This separates execution from its reported effects: calling a token contract and moving assets between two holders are different facts.

The YAML combines:

- Signed net asset gains and losses per address, with balance percentages when qualifying early balance reads exist.
- A payment summary describing gains, losses, and whether compensating movements were recorded in this transaction.
- The initiator, entry call, and direct call context, including decoded arguments and proxy forwarding.
- Decoded state changes with before/after values and numeric deltas, including address-valued changes that may matter for authorization.

Unknown storage is omitted. The YAML focuses on outcomes and initiating behavior; the diagram carries the deeper execution sequence. Event-derived movements remain distinct from independently verified balances, and arbitrary storage deltas are never automatically treated as assets.

### Build and compress the sequence diagram

D2.js renders participant lanes, function calls, returns, and asset arrows. An attributable token transfer can become an arrow between its holders, replacing an otherwise uninformative token-call subtree. Transfers without a known call position stay in YAML instead of receiving an invented place in the sequence. JPEG export runs locally through resvg and Sharp, without Java or a browser.

Compression works at several levels:

- **Proxy forwarding:** fold eligible call/delegatecall chains and use available implementation names while preserving the proxy's identity. Distinct proxies remain distinct participants.
- **Repeated behavior:** group consecutive matching calls or multi-call sequences into repetition blocks. Matching includes caller, callee, selector, call kind, value, outcome, storage context, and nested structure. Arguments and returns may vary; original iterations remain recoverable from diagnostics. Calls across different addresses are never merged.
- **Visual noise:** hide static calls and self-call arrows while preserving visible descendants and their endpoints. Function names alone do not determine whether a call is hidden.
- **Progressive simplification:** above 250 baseline arrow rows, shorten amounts, combine adjacent same-endpoint asset arrows, and use double-headed call/return arrows. If still above the threshold, hide undecoded intermediate calls while protecting initiating and reentry paths.
- **Image sizing:** reduce raster scale when dimensions exceed the pixel budget, then reduce JPEG quality and scale as needed for the byte budget.

The goal is to retain meaningful execution and asset relationships in an image a model can read. Compression changes presentation only; raw evidence, decoded calls, and YAML remain available at their original detail.

## Ask invariant questions

`decide` sends the report's YAML, image, or both to the [Vercel Decisions API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions). It does not send raw evidence or diagnostics. The model is explicit and configurable; select a model that supports images when using `both` or `image`.

Inspect a request locally without credentials or network access:

```sh
npm run dev -- decide --report artifacts/example-report \
  --questions examples/decisions-invariants.questions.json \
  --model openai/gpt-6-luna-decisions \
  --output artifacts/decisions-request.json --dry-run
```

With `AI_GATEWAY_API_KEY` configured, send it:

```sh
npm run dev -- decide --report artifacts/example-report \
  --questions examples/decisions-invariants.questions.json \
  --model openai/gpt-6-luna-decisions \
  --input-mode both --output artifacts/decisions-result.json
```

Use `--input-mode yaml` for text-only models or `image` to test the diagram alone. Requests have no automatic model fallback or retry. Results retain answers, refusals, usage, provider metadata, and input fingerprints. A refusal, error, or insufficient-evidence answer is not a safe verdict.

The example questions cover asset outflows, authorization changes, and value backing, separating suspicion from evidence of a violation. They are development prompts, not a validated exploit-detection benchmark. Supply your own question file for the invariants you care about.

## Evidence and limitations

- Calls come from `trace_transaction`. State diffs use `trace_replayTransaction` with `stateDiff`; no Geth debug or opcode tracers are used. `analyze` requests diffs by default; `--no-state-diff` disables them. Unavailable diffs are recorded in diagnostics.
- ABI and Solidity storage decoding use Sourcify metadata, checked against historical runtime code at block boundaries. Coverage depends on available metadata and candidate mapping keys; boundary checks cannot establish every intermediate code state. Unknown contracts receive readable aliases and opaque values retain their types.
- ERC-20 movements come from reported transfer events, not independently verified final balances. Native movements come from successful traces and exclude gas. Token symbols and decimals may require historical RPC reads. NFTs, rebases, and nonstandard token behavior are not fully represented.
- Execution paths do not prove authorization. The report does not establish earlier deposits, external fair prices, address ownership, or multi-transaction history. Some invariant violations need that context.
- Large images can lose useful detail through simplification or downscaling. YAML and images provide different evidence; combining them does not guarantee better model decisions.

Generic decoding is separate from semantic interpretation. Contract-specific interpretation belongs in explicitly configured adapters, rather than special cases in the decoder.

## Commands and options

```sh
npm run dev -- --help
```

| Command        | Purpose                                                              |
| -------------- | -------------------------------------------------------------------- |
| `analyze`      | Collect, decode, and generate a complete report                      |
| `check-config` | Validate local Alchemy configuration without contacting the provider |
| `collect`      | Save transaction evidence; opt into diffs with `--state-diff`        |
| `metadata`     | Fetch/cache Sourcify metadata; `--offline` reads the local cache     |
| `decode`       | Decode saved evidence using historically matched metadata            |
| `render`       | Render decoded execution without token interpretation                |
| `flow`         | Add asset interpretation, diagram, and YAML to saved evidence        |
| `decide`       | Submit an existing report and question file to a decision model      |

Collection and metadata caches default to `.cache/`. For `analyze`, `--no-cache` bypasses the collection cache and `--cached-metadata-only` skips Sourcify lookups while retaining required Alchemy reads. `--quality` (1–100) and `--scale` (0.25–4) set the requested JPEG quality and scale; automatic image limits may reduce them. Output paths must be new.

## Development

```sh
npm run check  # Typecheck, tests, formatting, and build
npm run build
node dist/cli.js --help
```

The pipeline in `src/pipeline/` coordinates `collection`, `metadata`, `decoding`, `interpretation`, and `rendering`. Model requests live in `src/decisions/`; question definitions live in `examples/`. Tests are in `test/`.
