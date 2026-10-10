# Invariant Monitor

Transaction evidence and visualization for Ethereum mainnet and Base mainnet, built in TypeScript. Decoding will use ABI and compiler metadata rather than contract-specific rules. D2.js is the selected sequence renderer.

The current checkpoint provides project tooling, local configuration validation, and collection interfaces. RPC collection, decoding, rendering, and inference are not implemented yet.

## Setup

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev -- check-config --chain ethereum
npm run dev -- check-config --chain base
```

Set `ALCHEMY_API_KEY` in the repository's ignored `.env` file or the process environment. Both chains use the same key. Environment values take precedence; an empty value is an error. By default, `.env` is read from the current working directory. Use `--env-file <path>` to select another file explicitly.

`check-config` checks local configuration only. It does not contact Alchemy or verify credentials, chain access, or trace-method availability.

## Development

```sh
npm run check
npm run format
npm run build
node dist/cli.js --help
```

| Location                  | Responsibility                                    |
| ------------------------- | ------------------------------------------------- |
| `src/config/`             | Chain definitions and credential loading          |
| `src/collection/types.ts` | Raw evidence and injectable collection interfaces |
| `src/cli.ts`              | CLI argument handling                             |
| `test/`                   | Offline configuration and CLI checks              |

Chain definitions and hash types come from viem. Each chain extends viem's definition with an Alchemy base URL; collection must use that explicit authenticated URL rather than viem's public default endpoint.

The RPC interface uses viem's request function and public RPC schema, extended with `trace_transaction` and state-diff replay. Trace responses remain `unknown` until the provider validates them. Viem's standard RPC types provide compile-time inference, not runtime validation. Raw evidence preserves provider data; it is separate from the eventual normalized execution model and model-facing YAML/images. State-diff availability is explicit, so an unavailable diff cannot be mistaken for an empty diff.

Each implementation milestone stops for review and a user-managed commit.
