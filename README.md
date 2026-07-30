[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/rsksmart/powpeg-sdk/badge)](https://scorecard.dev/viewer/?uri=github.com/rsksmart/powpeg-sdk)
[![CodeQL](https://github.com/rsksmart/powpeg-sdk/workflows/CodeQL/badge.svg)](https://github.com/rsksmart/powpeg-sdk/actions?query=workflow%3ACodeQL)

# powpeg-sdk
SDK for creating native peg-in and peg-out transactions following the PowPeg protocol.

## Installation

```bash
pnpm add @rsksmart/powpeg-sdk
```

## Quick Start

```ts
import { PowPegSDK, LedgerSigner } from '@rsksmart/powpeg-sdk'

const sdk = new PowPegSDK(null, null, 'TEST')

// Peg-in: BTC -> RBTC
const signer = await LedgerSigner.init('TEST')
const unsignedPegin = await sdk.createAndFundPegin(500_000n, '0xRecipientRskAddress', signer)
const txId = await sdk.signAndBroadcastPegin(unsignedPegin.psbt, unsignedPegin.inputs, unsignedPegin.transactions)

// Peg-out: RBTC -> BTC
const { tx, bitcoinFee, rootstockFee } = await sdk.createPegout('0.01', '0xSenderRskAddress')
await sdk.signAndBroadcastPegout(tx, someEthersSigner)
```

See [`docs/bitcoin-signers.md`](./docs/bitcoin-signers.md) for other ways to supply a `BitcoinSigner` (e.g. `TrezorSigner`, or your own implementation).

## API Reference

See [`docs/api.md`](./docs/api.md) for the full table of public exports (`PowPegSDK`, the bundled signers, and every exported type/error).

## Testing

```bash
pnpm test       # run once
pnpm coverage   # with coverage report
```

## Documentation

See [`docs/`](./docs/) for setup details, the full API reference, and the `BitcoinSigner` extension point (`docs/setup.md`, `docs/api.md`, `docs/bitcoin-signers.md`).

# How to publish a beta package?

* Update `package.json` `version` field to the format `<version>-beta.<i++>` (eg: 1.0.1-beta.0).
* Create tag matching the `version` field.
* Push pre-release for the github package.

# How to publish a package?

* Update `package.json` `version` field to the format `<version>` (eg: 1.0.1).
* Create tag matching the `version` field.
* Publish the github package.
