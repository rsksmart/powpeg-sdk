[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/rsksmart/powpeg-sdk/badge)](https://scorecard.dev/viewer/?uri=github.com/rsksmart/powpeg-sdk)
[![CodeQL](https://github.com/rsksmart/powpeg-sdk/workflows/CodeQL/badge.svg)](https://github.com/rsksmart/powpeg-sdk/actions?query=workflow%3ACodeQL)

# powpeg-sdk
SDK for creating native peg-in and peg-out transactions following the PowPeg protocol.

## Installation

```bash
npm install @rsksmart/powpeg-sdk
```

## Quick Start

```ts
import { PowPegSDK, TrezorSigner } from '@rsksmart/powpeg-sdk'

// Any BitcoinSigner implementation works here — TrezorSigner and LedgerSigner are provided.
const signer = await TrezorSigner.init('TEST')

// Pass null as the data source to use the SDK's bundled 2WP API client for the given network.
const sdk = new PowPegSDK(signer, null, 'TEST')

// Peg-in: build and fund a PSBT sending BTC to a Rootstock recipient address.
const { psbt, inputs, transactions } = await sdk.createAndFundPegin(
  500_000n,
  '0xRecipientRskAddress',
  signer,
)
const txId = await sdk.signAndBroadcastPegin(psbt, inputs, transactions)

// Peg-out: build an RSK transaction sending funds back to Bitcoin.
const { tx, rootstockFee, bitcoinFee } = await sdk.createPegout('0.01', '0xSenderRskAddress')
```

## API Reference

| Export | Description |
|---|---|
| `PowPegSDK` | Main entry point for creating and broadcasting native PowPeg peg-in and peg-out transactions. |
| `TrezorSigner` | `BitcoinSigner` implementation backed by a Trezor hardware wallet (`@trezor/connect-web`). |
| `LedgerSigner` | `BitcoinSigner` implementation backed by a Ledger hardware wallet over WebUSB. |
| `BitcoinSigner` | Interface for deriving addresses and signing transactions; implement it to use your own wallet integration. |
| `BitcoinDataSource` | Interface for supplying Bitcoin chain data (fees, UTXOs, broadcast); implement it to use your own data provider instead of the bundled API client. |
| `AmountBelowMinError` | Thrown when a requested peg-in/peg-out amount is below the SDK's minimum. |
| `NotEnoughFundsError` | Thrown when available UTXOs/balance can't cover the requested amount plus fees. |
| `InvalidAddressError` | Thrown when one or more Bitcoin addresses are invalid for the configured network. |
| `APIError` | Thrown when a call to the bundled 2WP API fails. |

See the doc comments on each exported symbol (`src/sdk/powpeg.ts`, `src/bitcoin-signers/`, `src/types.ts`, `src/errors.ts`) for full parameter and return details.

## Testing

```bash
pnpm test          # run the test suite once
pnpm test:watch     # run the test suite in watch mode
pnpm coverage        # run the test suite with coverage
```

# How to publish a beta package?

* Update `package.json` `version` field to the format `<version>-beta.<i++>` (eg: 1.0.1-beta.0).
* Create tag matching the `version` field.
* Push pre-release for the github package.

# How to publish a package?

* Update `package.json` `version` field to the format `<version>` (eg: 1.0.1).
* Create tag matching the `version` field.
* Publish the github package.
