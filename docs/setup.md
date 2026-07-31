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

Install it as a dependency of your own app:

```bash
pnpm add @rsksmart/powpeg-sdk
```

`PowPegSDK`'s constructor takes a `BitcoinSigner`, a `BitcoinDataSource`, the network, and optional URLs for the two services it talks to — there's no `.env` file to configure for the SDK itself; these are runtime constructor parameters instead, in this order:

| Parameter | Purpose | Default when omitted |
|---|---|---|
| `bitcoinSigner` | `BitcoinSigner` used to sign peg-in transactions (e.g. `LedgerSigner`, `TrezorSigner`) | `null` — required only for operations that sign transactions |
| `bitcoinDataSource` | `BitcoinDataSource` used for fee rates, UTXOs, tx broadcast and tx status | `null` — falls back to the built-in `apiUrl`-backed source |
| `network` | `'MAIN'` or `'TEST'` — selects Bitcoin network params and address validation rules | required |
| `rpcProviderUrl` | Rootstock JSON-RPC endpoint used to read the bridge precompile and send peg-outs | RSK public node for the given network (`https://public-node.rsk.co` / `https://public-node.testnet.rsk.co`) |
| `apiUrl` | 2WP API used as the default `BitcoinDataSource` (fee rates, UTXOs, tx broadcast, tx status) when no custom `BitcoinDataSource` is supplied | production 2WP API for the given network (`https://api.2wp.rootstock.io` / `https://api.2wp.testnet.rootstock.io`) |

## External dependencies

- **Rootstock RPC node** — read via `ethers.providers.JsonRpcProvider`, used for the bridge precompile (`Bridge` in `src/bridge.ts`) and to send peg-out transactions.
- **2WP API** — the SDK's built-in `BitcoinDataSource` implementation (`src/api/api.ts`); can be replaced with your own `BitcoinDataSource` for fee rates, UTXOs, tx broadcasting and address details.
- **Hardware wallets** (only needed if you use the bundled signers — see [`bitcoin-signers.md`](./bitcoin-signers.md)):
  - **Ledger** — via `@ledgerhq/hw-transport-webusb`, requires a browser environment with WebUSB support.
  - **Trezor** — via `@trezor/connect-web`.
