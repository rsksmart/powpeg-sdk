# Setup

## Prerequisites

- Node.js 22 (matches the version used in CI)
- [pnpm](https://pnpm.io/) 10.15.1 (pinned via the `packageManager` field in `package.json`; run via [Corepack](https://nodejs.org/api/corepack.html) or `corepack enable`)

## Install

```bash
pnpm install
```

## Build

```bash
pnpm build
```

Bundles `src/index.ts` into `dist/` as CJS and ESM (`dist/index.js`, `dist/index.mjs`) plus its type declarations (`dist/index.d.ts`), via `tsup`. Use `pnpm build:watch` to rebuild on change.

## Test

```bash
pnpm test          # run once
pnpm test:watch    # watch mode
pnpm coverage      # with coverage report
```

## Lint

```bash
pnpm lint          # eslint on src + GitHub Actions workflows
pnpm lint:fix      # auto-fix
```

## Consuming the package
[`See on NPM`](https://www.npmjs.com/package/@rsksmart/powpeg-sdk)
Install it as a dependency of your own app:

```bash
pnpm add @rsksmart/powpeg-sdk
```

`PowPegSDK`'s constructor takes a `BitcoinSigner`, a `BitcoinDataSource`, the network, and optional URLs for the two services it talks to — there's no `.env` file to configure for the SDK itself; these are runtime constructor parameters instead, in this order:

| Parameter | Purpose | Default when omitted |
|---|---|---|
| `bitcoinSigner` | `BitcoinSigner` used to sign peg-in transactions — supplied by the consumer, see [`bitcoin-signers.md`](./bitcoin-signers.md) | `null` — required only for operations that sign transactions |
| `bitcoinDataSource` | `BitcoinDataSource` used for fee rates, UTXOs, tx broadcast and tx status | `null` — falls back to the built-in `apiUrl`-backed source |
| `network` | `'MAIN'` or `'TEST'` — selects Bitcoin network params and address validation rules | required |
| `rpcProviderUrl` | Rootstock JSON-RPC endpoint used to read the bridge precompile and send peg-outs | RSK public node for the given network (`https://public-node.rsk.co` / `https://public-node.testnet.rsk.co`) |
| `apiUrl` | 2WP API endpoint. Used as the default `BitcoinDataSource` when no custom one is supplied, and always used for federation-address verification during peg-in creation regardless of `bitcoinDataSource` — see External dependencies below | production 2WP API for the given network (`https://api.2wp.rootstock.io` / `https://api.2wp.testnet.rootstock.io`) |
| `maxBundleSize` | Number of addresses to derive per `BitcoinSigner` call while creating a peg-in | `10` |
| `burnDustValue` | Change amount, in satoshis, below which it's dropped into the fee instead of added as an output | `2000` |
| `maxFeeRateSatPerByte` | Upper bound, in sat/B, for a fee rate coming from the configured `BitcoinDataSource`; a higher value throws `InvalidFeeRateError` | `1000` |
| `maxFeeToAmountRatio` | Upper bound for the ratio of total fee to peg-in amount; a higher ratio throws `InvalidFeeRateError` | `0.5` |

## External dependencies

- **Rootstock RPC node** — read via `ethers.providers.JsonRpcProvider`, used for the bridge precompile (`Bridge` in `src/bridge.ts`) and to send peg-out transactions.
- **2WP API** — the SDK's built-in `BitcoinDataSource` implementation (`src/api/api.ts`); the fee-rate/UTXO/broadcast/address-details methods can be replaced with your own `BitcoinDataSource`, but `createPegin` always calls the 2WP API's `/pegin-configuration` endpoint directly (via the internal `ApiService`, independent of `bitcoinDataSource`) to verify the federation address against the Bridge contract — this call cannot be substituted, so the 2WP API stays a required dependency even when every other data source is custom.
