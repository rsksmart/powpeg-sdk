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

`PowPegSDK`'s constructor takes a single `PowPegSDKOptions` object — there's no `.env` file to configure
for the SDK itself. Only `network` is required:

```ts
import { PowPegSDK, Network, type PowPegSDKOptions } from '@rsksmart/powpeg-sdk'

const options: PowPegSDKOptions = {
  network: Network.TEST,
  bitcoinSigner: mySigner,
  apiUrl: 'https://api.2wp.testnet.rootstock.io',
}

const sdk = new PowPegSDK(options)
```

`Network` is both a value and a type, so `Network.TEST` can be used where a network is expected and
`Network` can annotate configuration read from the environment:

```ts
const network: Network = isMainnet ? Network.MAIN : Network.TEST
```

The bare strings `'MAIN'` and `'TEST'` are still accepted, so either style works.


| Field | Purpose | Default when omitted |
|---|---|---|
| `bitcoinSigner` | `BitcoinSigner` used to sign peg-in transactions — supplied by the consumer, see [`bitcoin-signers.md`](./bitcoin-signers.md) | omitted — required only for operations that sign transactions |
| `bitcoinDataSource` | `BitcoinDataSource` used for fee rates, UTXOs, tx broadcast and tx status | omitted — falls back to the built-in `apiUrl`-backed source |
| `network` | `Network.MAIN` / `Network.TEST` (or the bare strings) — selects the Bitcoin network params, the Rootstock chain id and the default endpoints | required |
| `rpcProviderUrl` | Rootstock JSON-RPC endpoint used to read the bridge precompile and send peg-outs | RSK public node for the given network (`https://public-node.rsk.co` / `https://public-node.testnet.rsk.co`) |
| `apiUrl` | 2WP API endpoint. Used as the default `BitcoinDataSource` when no custom one is supplied, and always used for federation-address verification during peg-in creation regardless of `bitcoinDataSource` — see External dependencies below | production 2WP API for the given network (`https://api.2wp.rootstock.io` / `https://api.2wp.testnet.rootstock.io`) |
| `maxBundleSize` | Number of addresses to derive per `BitcoinSigner` call while creating a peg-in | `10` |
| `burnDustValue` | Change amount, in satoshis, below which it's dropped into the fee instead of added as an output | `2000` |
| `maxFeeRateSatPerByte` | Upper bound, in sat/B, for a fee rate coming from the configured `BitcoinDataSource`; a higher value throws `InvalidFeeRateError` | `1000` |
| `maxFeeToAmountRatio` | Upper bound for the ratio of total fee to peg-in amount; a higher ratio throws `InvalidFeeRateError` | `0.5` |
| `requestTimeoutMs` | Milliseconds before a request to the API is aborted; must be a positive integer | `10000` |

## Limits and behaviour worth knowing

- **Transport limits are adapter-dependent.** Every request carries a wall-clock deadline, enforced with
  an abort signal that all three adapters honour; axios's own `timeout` covers only the connect and idle
  phases on the Node adapter, so a server trickling bytes would otherwise hold a request open past it.
  The response-size cap (10 MB) is enforced by axios's Node adapter only — a browser consumer does not
  get it. Redirects
  are refused on every adapter: `maxRedirects: 0` covers Node, `fetchOptions.redirect: 'error'` covers
  the fetch adapter, and a response served by a host other than the configured one is rejected by an
  interceptor, which is what covers the browser adapter.
- **Broadcasting gets a longer bound than a read** (60 seconds, or the configured timeout if larger),
  because aborting it cannot un-relay a transaction that may already be in the mempool. The deadline is
  enforced even once the response has started arriving, so a broadcast that exceeds it fails without
  telling you whether the transaction reached the network — check its status rather than re-broadcasting.
- **The peg-out minimum is derived from the Bridge**, from its fee per kb and the active federation, and
  is taken as the larger of the size rule in force today and the one that activates with RSKIP378. That
  is never below the minimum the Bridge enforces; above a `feePerKb` of roughly 345,000 on mainnet it can
  be up to ~16% above it, which would reject amounts the Bridge would still accept. Today's `feePerKb`
  is 8,000 on both networks, where the two agree exactly.
- **Peg-outs are refused from contract accounts** before anything is sent, because the Bridge rejects a
  release requested from a contract *without refunding it*.
- **The provider is pinned to the configured network's chain id**, so a node reporting a different chain
  fails on its first call — including a local regtest or fork node.
- **The peg-out request carries its `chainId`**, and `signAndBroadcastPegout` hands the request to the
  signer as given, so gas, nonce and fee fields set by the caller are honoured — a replacement for a
  stuck peg-out reaches the node as a replacement. Both the request's `chainId` and
  `signer.getChainId()` are checked against the configured network first, and either mismatch throws
  `WrongNetworkError`; a request that omits `chainId` is stamped with the configured one. What the
  forwarded `chainId` is then worth at send time depends on the signer: ethers asserts it when it signs
  the transaction itself, while `JsonRpcSigner` passes it to the wallet without checking, so a browser
  wallet enforces it only if it chooses to.

## Migrating from 1.x

- `TrezorSigner` and `LedgerSigner` are no longer exported; supply your own `BitcoinSigner` (see
  [`bitcoin-signers.md`](./bitcoin-signers.md)).
- The constructor takes a single options object instead of nine positional parameters:
  `new PowPegSDK(signer, dataSource, 'TEST', undefined, apiUrl)` becomes
  `new PowPegSDK({ network: Network.TEST, bitcoinSigner: signer, bitcoinDataSource: dataSource, apiUrl })`.
- `signAndBroadcastPegout`'s first parameter is now the exported `UnsignedPegout` type, which extends
  ethers' `TransactionRequest`. A request built by hand still needs `from`, `to` and `value`; the gas,
  nonce and fee fields ethers serializes are now allowed and forwarded. The request reaches the signer
  as given, so a field ethers does not recognise is no longer dropped in silence — it reaches ethers and
  is rejected there (`invalid transaction key` when the signer signs the transaction itself, `invalid
  object key` through `JsonRpcSigner`). TypeScript catches such a field only when the request is written
  as a literal at the call site, not when it is built in a variable first.
- Five error types are new — `SigningError`, `WrongNetworkError`, `PegoutRejectedError`,
  `UnsupportedSenderError` and `TransactionRevertedError` — and `APIError.message` now derives from the
  API's own message rather than a
  constant: control characters are replaced with spaces and the text is capped at 300 characters, so a
  message that survives is the API's own wording but not necessarily byte-for-byte. Code that classifies
  SDK failures by message text should be re-checked.
- `requestTimeoutMs` is validated: it must be a positive integer no greater than 2147483647. `0`, which
  1.x accepted as "no timeout", now throws at construction.

## External dependencies

- **Rootstock RPC node** — read via `ethers.providers.JsonRpcProvider`, used for the bridge precompile (`Bridge` in `src/bridge.ts`) and to send peg-out transactions. Peg-out estimation additionally reads `getFeePerKb()`, `getActivePowpegRedeemScript()`, `getFederationThreshold()` and `getFederationAddress()` from the Bridge, to derive the minimum amount the Bridge currently enforces rather than assume a fixed one, so a node that cannot serve those calls will fail `estimatePegoutFees` and `createPegout`. The provider is pinned to the configured network's chain id, so a node reporting a different chain fails on the first call.
- **2WP API** — the SDK's built-in `BitcoinDataSource` implementation (`src/api/api.ts`); the fee-rate/UTXO/broadcast/address-details methods can be replaced with your own `BitcoinDataSource`, but `createPegin` always calls the 2WP API's `/pegin-configuration` endpoint directly (via the internal `ApiService`, independent of `bitcoinDataSource`) to verify the federation address against the Bridge contract — this call cannot be substituted, so the 2WP API stays a required dependency even when every other data source is custom.
