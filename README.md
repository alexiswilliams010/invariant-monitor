# Invariant Monitor

Transaction evidence and visualization for Ethereum mainnet and Base mainnet, built in TypeScript. Decoding will use ABI and compiler metadata rather than contract-specific rules. D2.js is the selected sequence renderer.

The current checkpoint collects transaction evidence, resolves Sourcify metadata, decodes ABI calls and declared Solidity storage, groups repeated call sequences, and exports D2 diagrams and YAML outcome summaries. Inference is not implemented yet.

## Setup

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev -- check-config --chain ethereum
npm run dev -- check-config --chain base
```

Set `ALCHEMY_API_KEY` in the repository's ignored `.env` file or the process environment. Both chains use the same key. Environment values take precedence; an empty value is an error. By default, `.env` is read from the current working directory. Use `--env-file <path>` to select another file explicitly.

`check-config` checks local configuration only. It does not contact Alchemy or verify credentials, chain access, or trace-method availability.

## One-command report

```sh
npm run dev -- analyze --chain ethereum \
  --tx 0xd29d1c8d9a1b424d4e0f472bd7b4a994028d35e9737c591eae51d917543bb854 \
  --output artifacts/ethereum-report
```

Use `--chain base` for Base mainnet. `analyze` coordinates collection, historical metadata matching, decoding, interpretation, rendering, and YAML export. It produces `sequence.jpg` and `outcomes.yaml`, alongside `sequence.d2`, `sequence.svg`, `evidence.json`, `decoded.json`, `decoded.json.diagnostics.json`, and `interpretation.diagnostics.json`. No model endpoint is called.

The output directory must not already exist. Output paths are reserved before network requests. Failed runs remove their own output files, while reusable collection and metadata caches remain. The command reports its current stage on stderr. It validates the canonical block after token metadata lookup before rendering.

Unlike the standalone `collect` command, `analyze` requests state diffs by default; `--no-state-diff` disables them. Unavailable state diffs remain explicit in diagnostics and do not prevent the rest of the report. `--no-cache` skips the collection cache; `--cache-dir` and `--metadata-dir` choose cache locations. `--cached-metadata-only` avoids Sourcify requests but still uses Alchemy for collection, historical code validation, and token metadata. `--env-file`, `--quality`, and `--scale` work as in the standalone commands. The YAML schema is unchanged.

## Collection

```sh
npm run dev -- collect --chain ethereum \
  --tx 0xa1f1e65c1cea4dba4ae439cd4dcdba6cc2dbda0ed1228e61f29ae9c9324eb099 \
  --state-diff --output artifacts/ethereum-fixture.json
```

Use `--chain base` with a Base transaction hash. Output paths must not already exist. Artifacts contain raw evidence, normalized call frames, and request timings; they are diagnostic JSON, not the eventual model-facing YAML or images.

Calls come from `trace_transaction`. Opt-in state diffs use `trace_replayTransaction` with only `stateDiff` requested. No debug or opcode tracers are used. A provider failure or null diff is recorded as unavailable; malformed responses fail validation. Failure to retrieve call traces fails collection.

The collector checks chain, transaction, receipt, trace, and canonical block identities. Call frames preserve nesting, call type, delegated storage context, inherited reverts, and exact decimal values. Receipt logs and raw trace results remain available for later decoding. Logs are not yet attributed to individual calls.

Validated evidence is cached in `.cache/collections`, keyed by chain, block hash, transaction hash, schema version, and state-diff mode. Cache hits still refresh transaction, receipt, and canonical block evidence and revalidate cached traces. Unavailable state diffs are retried on the next collection. Use `--cache-dir <path>` to relocate the cache or `--no-cache` to bypass it.

Live checks collected 55 call frames from the supplied Ethereum fixture and 68 from one finalized Base sample. State diffs succeeded on both: approximately 531 ms on Ethereum and 554 ms on Base for these requests. These measurements do not establish how Alchemy executes replay internally or predict latency for other transactions.

## Contract metadata

```sh
npm run dev -- metadata --chain ethereum \
  --address 0x27c76df6912698e6d4c55aaa87cf88c30db90cf7 \
  --output artifacts/contract-metadata.json

npm run dev -- metadata --chain ethereum \
  --address 0x27c76df6912698e6d4c55aaa87cf88c30db90cf7 \
  --offline --output artifacts/contract-metadata-offline.json
```

Metadata lookup needs no Alchemy credentials. The command resolves one address using Sourcify API v2, requesting ABI, storage layout, compiler identity/name, deployment details, and on-chain runtime bytecode. It saves the runtime bytecode's hash for later evidence matching. It does not request sources, full compiler output, or proxy resolution. [API documentation](https://docs.sourcify.dev/docs/api/)

The cache defaults to `.cache/metadata`. ABIs and layouts are stored separately by canonical JSON content hash, so identical artifacts can be shared across addresses and chains. Object key order is normalized; array order, names, and compiler type information are preserved. Address indexes remain chain-specific. `--offline` only reads local metadata, `--refresh` fetches a new record, and `--cache-dir` selects another store. Only successful lookups are cached; missing records and transient failures can be retried later. Cached records retain fetch time and verification provenance, and have no automatic expiry.

Missing metadata, an empty ABI/layout, an offline cache miss, and provider failure stay distinct. ABI entries and storage layouts are preserved as compiler artifacts; their decoding semantics are not validated yet. Solidity and Vyper layouts have different shapes. Sourcify names and verification quality are retained without deriving contract behavior from them. [Lookup fields](https://docs.sourcify.dev/blog/apiv2-lookup-endpoints/)

Metadata lookup alone does not bind the metadata to historical execution. The decoding command below checks historical runtime code before using it. Asset interpretation remains pending.

Live lookup of the Ethereum fixture's nested `SubmitImports` contract returned 30 ABI entries and 25 storage declarations. The root target and the two checked Base addresses were not verified in Sourcify; those results do not establish coverage for other addresses.

### Larger offline dataset

Sourcify publishes daily Parquet exports. `compiled_contracts.compilation_artifacts` contains ABI and storage layouts, and `verified_contracts` connects compilations to `contract_deployments`. A future importer can select Ethereum/Base deployments and reuse this store's deduplicated artifacts. Bulk import and deployment-date filtering are not implemented in this checkpoint. [Database schema](https://docs.sourcify.dev/docs/contract-dataset/sourcify-database/), [dataset download](https://docs.sourcify.dev/docs/repository/download-dataset/).

The deployment cutoff must use on-chain deployment blocks and their timestamps, not verification time or dataset row creation time. Missing deployment details should remain unknown. Keep ABIs independently of the layout retention cutoff. The export's `sourcify_matches` table can contain multiple versions of a row; an importer must select the latest `updated_at` for each ID. Use the dataset for bulk work rather than crawling the lookup API. [Export semantics](https://docs.sourcify.dev/docs/repository/download-dataset/)

## ABI decoding

```sh
npm run dev -- decode --input artifacts/ethereum-fixture.json \
  --output artifacts/ethereum-decoded.json
```

The command revalidates saved evidence and rebuilds call frames from the raw traces. It resolves metadata for distinct called addresses and compares Sourcify's runtime-code hash with Alchemy's `eth_getCode` results at the previous and transaction block boundaries. It checks the canonical transaction block before and after decoding, and rejects mismatched code, later deployments, and addresses created or destroyed within the transaction. This uses standard RPC reads, without tracing or replaying the transaction again.

The diagnostic label `block-code-match` describes those observations. It is not proof of the exact bytecode at every intra-block execution point: matching boundary code cannot exclude temporary intervening code changes. Missing historical code or unmatched metadata produces a generic fallback instead of an ABI-derived name.

Function signatures come only from the matched contract ABI. The decoder handles overloads by selector and declines ambiguous selector collisions. It decodes inputs and successful outputs using viem, then re-encodes them to check exact correspondence. Malformed or noncanonical arguments retain their declared types. Unsupported ABI entries stay undecoded. Reverted outputs remain bytes; custom-error decoding is pending. No contract-specific or contract-type-specific rules are used.

Display JSON preserves every call's identity, parent, sender, target, code/storage context, kind, value in wei, and revert/read-only status. Names come from matched compiler metadata; duplicate names receive distinct suffixes. Unknown addresses get stable aliases for that artifact, with `New_Contract` reserved for observed creations. Integer values are exact decimal strings. Addresses become names, arrays and tuples are recursive, and opaque bytes retain only their type. Long strings are capped at 512 characters, arrays over 256 items fall back to their type, and embedded hex text is removed.

The sibling `<output>.diagnostics.json` holds addresses, transaction identity, metadata bindings, and decode coverage separately. Only the display file is intended as input to the later YAML/image presentation step. `valueWei` records call semantics and is not an asset-transfer ledger; in particular, a delegated call's value must not be counted as another transfer. Both output paths must be new.

`--metadata-dir` selects a metadata store. `--cached-metadata-only` skips Sourcify network lookups but still uses Alchemy for historical code checks. `--env-file` selects Alchemy credentials as with collection. Full offline decoding, signature-database fallback, receipt-event decoding, and constructor decoding are not included yet.

Live validation decoded ABI arguments for 46 of 55 calls in the Ethereum fixture and 42 of 68 in the Base sample. This is ABI coverage, not a claim that opaque bytes were interpreted. Every original call edge remained present, and both display files contained no hex representations.

## Storage decoding

The `decode` display includes `storage.status` and transaction-level `storage.changes`. To include storage, collect evidence with `--state-diff`. Existing evidence files remain version 1. No additional state reads or replay calls are needed for storage decoding.

Layouts come from code-matched Solidity metadata for non-reverted, writable call contexts. Delegated code contributes its layout to the caller's storage context. Compatible declarations are deduplicated; overlapping conflicting declarations stay `storage`. Changes are not assigned to an individual call because net state diffs do not identify the writing frame. Historical code matching retains the block-boundary limitations described above.

The decoder handles packed integers, booleans, addresses, structs, nested mappings, fixed arrays, and dynamic arrays whose length is present in the diff. It computes mapping slots from candidate keys and only attributes exact matches. Candidates come from call participants, calldata/return words, decoded ABI values, receipt topics/data, and changed storage words. Dynamic string/bytes keys use their unpadded data. These are generic compiler-layout rules, not protocol or token-interface rules. [Solidity layout specification](https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html)

Display changes carry the variable path, declared type, decoded before/after values when available, and exact integer deltas. An integer delta is a state change, not an inferred asset amount. Opaque bytes remain types; a matched mapping entry with an opaque key displays `[unknown]`. Unmatched slots and uncovered changed bits display only `storage`. Short strings decode when their storage word contains the complete valid UTF-8 value. Long string/bytes payloads remain types, and data words cannot be attributed if the required header is absent from the diff.

Search is bounded: 512 candidate words, 128 keys per type, 256 array elements, 8 KiB of long byte/string payload locations, 24 levels, and 50,000 traversal visits per layout. Diagnostics flag limited searches. Exceeding traversal limits discards that account's partial attribution; unresolved changes remain present. Unknown dynamic-array lengths, missing/invalid layouts, Vyper layouts, and unsupported types do not trigger contract-specific heuristics.

Live fixtures attributed 7 of 38 changed Ethereum slots and 19 of 22 Base slots. Some slots contain multiple changed packed fields. The remaining slots stayed `storage`, and both display files remained hex-free. Raw slot addresses and attribution status are recorded only in the sibling diagnostic file.

## Call-sequence compression

`decode` now produces display schema version 3 with a `sequence` tree. Call nodes reference the complete `calls` list by ID. Repeat nodes contain a representative body and count; a renderer can show this as a loop box with `x20`. All original call facts and transaction-level storage changes remain available.

Only consecutive sibling calls or sibling blocks can repeat. Every corresponding call must match its raw caller, callee, storage context, call kind, selector, value in wei, revert/read-only flags, and nested call structure. Contract names and human-readable function labels are not grouping keys. Intermediate calls stay in the representative body, and grouping never changes an edge's endpoints. Creation and destruction are excluded.

Arguments and return data may differ. Raw byte comparisons set `diffArgs` and `diffReturns`, including when the readable value is only `bytes`. A renderer must mark these differences rather than presenting the first iteration's values as universal. No per-iteration state effects are inferred from transaction-level state diffs.

The compressor considers patterns up to 32 sibling subtrees, chooses the greatest local reduction, and favors shorter patterns on ties. It is deterministic, not a globally optimal compressor. Diagnostics record all call IDs for every iteration; expanding those records restores the original call order. Repeated bodies are recursively compressed, including consecutive runs within an outer repeated block. Nested representative loops retain their own records, while outer repeat records cover every original iteration.

On saved fixtures, Ethereum's 55 calls become 39 representative calls in three repeated blocks, including an inner three-call run. Base retains all 68 calls because no eligible repetition was found. These checks run locally without additional network requests.

## Sequence diagrams

```sh
npm run dev -- render --input artifacts/ethereum-sequence.json \
  --output artifacts/ethereum-diagram --quality 90 --scale 1
```

Use a display schema version 3 file from `decode`. Rendering runs locally without credentials or network requests, and writes `<prefix>.d2`, `<prefix>.svg`, and `<prefix>.jpg`. All three paths must be new. Invalid inputs and failed exports remove only files created by that attempt.

D2.js runs through its Node/WASM API. SVG rasterization uses resvg, and Sharp encodes JPEG; no Java, browser, or React runtime is required. JPEG quality is 1–100 and scale is 0.25–4, with a 50-million-pixel limit. Scale changes raster dimensions, while quality changes JPEG compression. The SVG remains at its original vector dimensions. JPEG text uses available system fonts with Arial as its fallback; font appearance can differ from D2's embedded SVG fonts. [D2.js](https://github.com/d2lang/d2/tree/master/d2js/js), [resvg](https://github.com/thx/resvg-js).

The image uses shared participant lanes, solid call arrows, and dashed return arrows. Single-call repetition is shown on the arrow (`createHash ×3`); repeated multi-call bodies use a `Repeat ×N` box. Argument/return differences remain in the data instead of the labels. Reverted calls are red. D2 measures labels and renders the diagram; a compact layout reduces vertical whitespace while retaining room for group headings. Standalone D2 source therefore has different spacing. Labels exclude raw hex and escape D2 syntax. [D2 sequence diagrams](https://d2lang.com/tour/sequence-diagrams/)

Successful `STATICCALL` subtrees are omitted from both diagram views, including nested calls that inherit the static context. Failed reads and the ancestor calls needed to locate them remain visible. Empty repeat boxes and lanes used only by hidden reads are removed. Self-call arrows and markers are omitted while preserving their nested calls in order with their original endpoints. This is a presentation filter: decoded calls, arguments, results, and raw evidence remain unchanged. Function names and ABI `view` labels alone do not trigger filtering, so an ordinary `CALL` named `balanceOf` remains visible. The asset view also omits unplaced zero-value transfers from the image, while retaining their reported events in the evidence.

Participant naming is independent of forwarding compression. An observed, unambiguous delegation in the host's storage context supplies the implementation name, even when the forwarding call cannot be collapsed. Multiple implementation targets or unnamed implementations leave the original label unchanged. The asset view prefers available token symbols. Labels never merge identities; duplicate labels receive distinct suffixes, and raw addresses and original names remain in the evidence.

The image emphasizes function names. The plain `render` command does not interpret token movements or draw storage changes. Use `flow` below for the asset view. Nonzero ordinary CALL values are shown in exact wei; these are attempted call values, not a net asset ledger. Delegated value is not shown as another transfer. No contract-specific asset interpretation is added.

The JPEG is the image intended for API input; SVG is an optional inspection source. Traces currently produce one image; pagination and image tiling remain future work.

The presentation folds an ordinary CALL or STATICCALL with a sole DELEGATECALL child when the child executes in the same storage context, the outcomes agree, and the outer action is unknown or matches the child. The incoming arrow retains the proxy identity and uses the implementation action/name. Multiple proxy addresses remain distinct even when they share implementation code. Other delegation, branching, and distinct named actions stay visible. This is an observed forwarding relationship, not protocol-specific proxy detection. Original calls and storage facts remain unchanged in the display JSON; folding is only a rendering step. Return arrows follow the call tree; full parent relationships remain in JSON.

## Interpretation foundation

`src/interpretation/` separates semantic interpretation from generic ABI/storage decoding. It defines a versioned internal document for asset movements, net asset balance changes, and contract state changes. Each fact carries evidence references and distinguishes event-reported, state-observed, and inferred interpretations. Transaction-level facts remain separate from facts attributed to a specific call. Net balance changes do not imply a particular sender/recipient pairing or transfer order.

`TransactionInterpreter` receives an explicit list of adapters. Standard-token adapters can apply across a transaction; contract-specific adapters are scoped to a configured chain and address. Duplicate adapter IDs, facts without evidence references, and facts emitted with an unavailable/not-applicable status are rejected. Adapters are trusted interpretation code: these checks do not establish that their semantic conclusions are correct. Adapter exceptions fail the run. No adapters are registered by default.

`SelectedStateAdapter` selects existing decoded changes for one contract, optionally by exact field/path name. For example, a future target can expose `shares: 100 → 120` as a state change without treating it as an asset transfer. Omitting the field list includes all that contract's recorded changes; an empty list selects none. Unattributed slots remain `storage`, and an unavailable diff remains unavailable. Selection does not introduce custom storage decoding or assign net changes to individual calls.

Contract-specific calculations can implement the same adapter interface when targets are supplied. Interpretations retain adapter IDs and references to the original evidence. Asset amounts, balances, and token IDs use exact decimal strings; missing symbols/decimals remain unknown. These internal documents can contain raw addresses and must pass through name resolution before model-facing YAML/images. They must not be sent directly to a model.

The standard ERC-20 adapter and asset view below are wired through a separate `flow` command. Selected-contract configuration, semantic conflict reconciliation across adapters, and selected-state rendering remain pending. Generic ABI/storage decoding is unchanged.

## Asset-flow diagrams

```sh
npm run dev -- flow --input artifacts/ethereum-fixture.json \
  --display artifacts/ethereum-sequence.json --output artifacts/ethereum-assets
```

The command requires the matching `<display>.diagnostics.json` file. It checks identities and call/address correspondence, revalidates raw evidence, and recomputes repetition groups. Outputs are D2, SVG, JPEG, YAML, and a diagnostic JSON sidecar; all paths must be new. The sidecar contains raw evidence references and is not model-facing input.

The standard adapter recognizes the ERC-20 Transfer event layout and records movements against the emitting contract address, including proxies. NFT Transfer layouts are excluded. Optional symbols/decimals come from successful metadata calls already in the trace, or historical `eth_call` reads at the transaction block with chain and canonical-block checks. Legacy bytes32 symbols are supported. Historical reads describe block-end metadata, not an isolated transaction-time snapshot. `--offline` disables RPC access; missing decimals use exact raw units, never an assumed scale. Matching symbols get distinct labels when asset addresses differ. [ERC-20](https://eips.ethereum.org/EIPS/eip-20)

A transfer arrow runs between holders, labelled with the amount and asset. A token call is replaced only when exactly one reported event matches exactly one successful ordinary transfer/transferFrom call by emitting token, holders, and amount. Its subtree must be empty or a chain of same-calldata delegate forwarding in the same storage context. False returns, callback subtrees, amount mismatches, and ambiguous matches retain their calls. Successfully decoded symbol/decimals reads for observed tokens can be omitted. Approvals and other protocol operations are not hidden. Repeated representative calls remain calls because one representative amount cannot stand for every iteration.

Token arrows mean **event-reported movement**, not independently proven balance changes. Event-to-call association is an inference from a unique match; `trace_transaction` does not bind receipt logs to frames. Events without that match appear separately under “Reported transfers · call position unknown”, without claiming they occurred after the call sequence. State corroboration is explicitly unavailable in this checkpoint: generic numeric storage deltas, including packed fields, are not automatically token balances. Rebase/fee semantics, nonstandard token logs, NFTs, and ERC-1155 interpretation remain outside this adapter.

Successful empty-calldata leaf CALLs with nonzero native value become native-asset arrows. Calls with calldata or children retain their execution detail; gas fees and a full native net-balance ledger are not inferred. Asset arrows have no return arrow; ordinary calls retain dashed returns.

On the Ethereum fixture, seven ERC-20 movements are reported. Six replace transfer-call subtrees, while one DAI mint remains unplaced. FiatToken proxy assets appear as USDC and EURC, identified by separate proxy addresses; implementation contracts are not token holders or assets. Underlying call/storage evidence remains intact.

## YAML outcomes

`flow` also writes `<prefix>.yaml`, using the same resolved participant names as the image. It contains transaction status, initiator, selected call context, signed net ERC-20 movement per address, and decoded state differences.

`call_context` describes initiating behavior: the entry call and its direct non-static calls. Delegate forwarding stays at the same depth, so proxy implementation arguments remain available. Deeper execution is left to the diagram and raw evidence. There is no call-count limit within these two layers. Each entry records the effective EVM caller, target storage context, function, and typed arguments. `via` lists intermediate contract contexts from the initiator toward the target; delegate forwarding keeps the effective caller and identifies implementation code separately. This is an execution path, not a claim that the initiator controls every intermediate address or that a successful call was authorized. Reverted calls are marked. Arguments keep ABI names and exact unscaled integers; nested address values use the same participant labels as state and assets. All available decoded argument values are preserved recursively; opaque values retain their type. Call references stay in diagnostics. No contract-specific adapters or inferred owner/recipient roles are used.

```yaml
version: 1
chain: ethereum
status: success
token_net_from_transfers:
  Safe:
    - -20 USDC
  Recipient:
    - +20 USDC
decoded_state:
  Vault:
    - field: shares[Safe]
      type: uint256
      before: "100"
      after: "120"
```

`native_transfers` records value moved by successful CALL, CREATE, CREATE2, and SELFDESTRUCT traces between distinct addresses. `native_net_from_transfers` aggregates those movements, including calls with calldata and intermediate routing. Inherited DELEGATECALL/CALLCODE value, reverted effects, self-transfers, and zero values are excluded. These totals exclude gas and are not full account balance diffs; fees, self-destruction to self, and chain-specific balance adjustments are not inferred. Amounts use the chain’s native currency decimals. Call references and exact wei amounts remain in diagnostics.

Token totals use every interpreted receipt transfer, including transfers without call placement. Aggregation keys are asset and holder addresses, never symbols. Integer arithmetic remains exact; known decimals format quantities, missing decimals retain raw units, and zero net totals are omitted. Mint/burn zero-address endpoints are not presented as holders. These totals are derived from events, not final balances or proof of storage-backed balance changes. Native assets, gas, NFTs, rebases, and unreported movements are outside this section.

When the trace contains a qualifying early `balanceOf(holder)` read, totals include a percentage such as `-20 USDC (-100%)`. The read must be a successful canonical `STATICCALL` before any potentially state-changing execution in that token's storage context. Delegate forwarding is allowed; other nested calls, conflicting early values, and later reads are excluded. The denominator is the token-reported balance observed before its first potential write, under standard ERC-20 semantics; it is not independently verified storage. No previous-block approximation, event-based balance reconstruction, extra RPC call, or replay is used. Caller-dependent or other nonstandard balance semantics remain outside this interpretation.

Zero prior balances produce `new balance` for positive movement. Missing denominators or totals implying a negative final balance omit the percentage. Percentages use integer arithmetic; inexact results are truncated to two decimal places and marked `~`, and sub-0.01% changes use `<0.01%`. A partial drain is never rounded to `-100%`. Supporting balance call IDs and exact denominators remain in diagnostics. Decoded storage before/after values are retained, and authorization extraction remains separate.

State entries require a decoded type and both values. Unknown slots and opaque values are omitted; coverage counts remain only in the diagnostic sidecar. Integer values remain strings, boolean values remain booleans, and generic storage values are not scaled using token decimals. Decoded int/uint changes also include an exact signed `delta` (after minus before); addresses, booleans, and opaque values do not. A delta describes the numeric field only, without inferring authorization or asset semantics. Address-valued fields and known mapping keys reuse participant labels; unresolved keys remain `unknown`. Lists preserve distinct changes whose displayed field names coincide. The diagnostic sidecar links totals to receipt logs and state entries to decoded change IDs, keeping raw addresses out of YAML.

## Decisions API

`decide` sends an existing report's `outcomes.yaml` and `sequence.jpg` to Vercel. It does not recollect the transaction or send raw evidence, SVGs, or diagnostics. The YAML is unchanged; a short input preamble explains evidence and diagram semantics. Questions live in a separate JSON array with predicate, choice, or score definitions.

`examples/decisions-invariants.questions.json` separates suspicion from evidence of a violation for asset outflows, authorization, and value backing (six questions total). Suspicion uses `yes`/`no`; violation uses `yes`, `no`, or `insufficient_evidence`, retaining “if not broken then say no.” Suspicion is not proof, and insufficient evidence is not a safe verdict. Valid withdrawals, delegations, liquidations, and prior backing remain possible explanations, without treating familiar operation names as proof of legitimacy. These questions were revised using the five development examples; performance on those examples is not held-out validation. Earlier run artifacts preserve their original questions and definitions. Address groups, protocol-specific questions, and benchmark calibration remain deferred.

Vercel accepts images as base64 data URLs. Use an image-capable decision model such as `openai/gpt-6-luna-decisions`; `typesafe-ai/jev` is text-only and rejects these requests. The model slug is explicit, with no automatic fallback or image removal. [Vercel Decisions API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions)

Inspect the exact request locally first:

```sh
npm run dev -- decide --report artifacts/ethereum-d29d1c8d-report \
  --questions examples/decisions-invariants.questions.json \
  --model openai/gpt-6-luna-decisions \
  --output artifacts/decisions-request.json --dry-run
```

The separate `examples/decisions-smoke.questions.json` only checks report reading. A dry run needs no API key and makes no network request. It writes the full image payload, so the resulting JSON can be large.

Add `AI_GATEWAY_API_KEY` to the ignored `.env`, then send the same report:

```sh
npm run dev -- decide --report artifacts/ethereum-d29d1c8d-report \
  --questions examples/decisions-invariants.questions.json \
  --model openai/gpt-6-luna-decisions \
  --output artifacts/decisions-result.json
```

`--input-mode` accepts `yaml`, `image`, or `both` (default), allowing comparisons with the same report and questions. Image-only requests include the shared evidence-reading instructions but no YAML facts; YAML-only requests contain no image. `--detail` accepts `low`, `high` (default), `auto`, or `original`. `--env-file` selects another environment file; environment variables take precedence. Alchemy credentials are not required for `decide`.

The result preserves ordered answers (including refusals), returned model, usage, and provider metadata, alongside requested model, questions, image detail, duration, and SHA-256 fingerprints of the inputs and exact request. An API error is not a negative decision. Requests time out after two minutes and are not automatically retried; a timed-out request may still have been processed and billed. Output paths must be new and are reserved before sending. Run the command again with a different model and output path to compare providers against the same report.

## Development

```sh
npm run check
npm run format
npm run build
node dist/cli.js --help
```

| Location              | Responsibility                                               |
| --------------------- | ------------------------------------------------------------ |
| `src/config/`         | Chain definitions and credential loading                     |
| `src/collection/`     | RPC access, validation, call normalization, cache            |
| `src/metadata/`       | Sourcify lookup, provenance, deduplicated offline store      |
| `src/decoding/`       | Historical code checks, ABI/storage decoding, readable facts |
| `src/interpretation/` | Asset/state fact contracts and explicitly scoped adapters    |
| `src/rendering/`      | Sequence validation, D2 generation, SVG/JPEG export          |
| `src/cli.ts`          | CLI argument handling                                        |
| `test/`               | Configuration, CLI, RPC, and collection checks               |

Chain definitions and hash types come from viem. Each chain extends viem's definition with an Alchemy base URL; collection must use that explicit authenticated URL rather than viem's public default endpoint.

The RPC interface uses viem's request function and public RPC schema, extended with `trace_transaction` and state-diff replay. Trace responses remain `unknown` until the provider validates them. Viem's standard RPC types provide compile-time inference, not runtime validation. Raw evidence preserves provider data; it is separate from the eventual normalized execution model and model-facing YAML/images. State-diff availability is explicit, so an unavailable diff cannot be mistaken for an empty diff.

Each implementation milestone stops for review and a user-managed commit.
