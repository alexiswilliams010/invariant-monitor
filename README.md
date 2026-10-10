# Invariant Monitor

Transaction evidence and visualization for Ethereum mainnet and Base mainnet, built in TypeScript. Decoding will use ABI and compiler metadata rather than contract-specific rules. D2.js is the selected sequence renderer.

The current checkpoint collects transactions, receipts, call traces, and optional state diffs. Decoding, rendering, and inference are not implemented yet.

## Setup

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev -- check-config --chain ethereum
npm run dev -- check-config --chain base
```

Set `ALCHEMY_API_KEY` in the repository's ignored `.env` file or the process environment. Both chains use the same key. Environment values take precedence; an empty value is an error. By default, `.env` is read from the current working directory. Use `--env-file <path>` to select another file explicitly.

`check-config` checks local configuration only. It does not contact Alchemy or verify credentials, chain access, or trace-method availability.

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

## Development

```sh
npm run check
npm run format
npm run build
node dist/cli.js --help
```

| Location          | Responsibility                                    |
| ----------------- | ------------------------------------------------- |
| `src/config/`     | Chain definitions and credential loading          |
| `src/collection/` | RPC access, validation, call normalization, cache |
| `src/cli.ts`      | CLI argument handling                             |
| `test/`           | Configuration, CLI, RPC, and collection checks    |

Chain definitions and hash types come from viem. Each chain extends viem's definition with an Alchemy base URL; collection must use that explicit authenticated URL rather than viem's public default endpoint.

The RPC interface uses viem's request function and public RPC schema, extended with `trace_transaction` and state-diff replay. Trace responses remain `unknown` until the provider validates them. Viem's standard RPC types provide compile-time inference, not runtime validation. Raw evidence preserves provider data; it is separate from the eventual normalized execution model and model-facing YAML/images. State-diff availability is explicit, so an unavailable diff cannot be mistaken for an empty diff.

Each implementation milestone stops for review and a user-managed commit.
