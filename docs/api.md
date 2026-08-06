# API Reference

Public exports of the package's entry point (`src/index.ts`). Each description is the first line of that symbol's TSDoc comment — see the linked source file for the full contract.

## SDK

| Export | Kind | Description |
|---|---|---|
| [`PowPegSDK`](../src/sdk/powpeg.ts) | class | SDK for creating, funding, signing and broadcasting native PowPeg peg-in (BTC -> RBTC) and peg-out (RBTC -> BTC) transactions. |

See [`PowPegSDK`](../src/sdk/powpeg.ts) for the full list of methods (`estimatePeginFee`, `createPegin`, `fundPegin`, `createAndFundPegin`, `createAndFundPsbt`, `signAndBroadcastPegin`, `estimatePegoutFees`, `createPegout`, `signAndBroadcastPegout`, `getTransactionStatus`, `getAvailableUtxos`) — each documented in place with its params and return type.

## Bitcoin signers

See [`bitcoin-signers.md`](./bitcoin-signers.md) for the `BitcoinSigner` contract and the bundled implementations.

| Export | Kind | Description |
|---|---|---|
| [`TrezorSigner`](../src/bitcoin-signers/trezor/trezor.ts) | class | `BitcoinSigner` backed by a Trezor hardware wallet, connected via `@trezor/connect-web`. |
| [`LedgerSigner`](../src/bitcoin-signers/ledger/ledger.ts) | class | `BitcoinSigner` backed by a Ledger hardware wallet, connected over WebUSB. |

## Types (`src/types.ts`)

| Export | Kind | Description |
|---|---|---|
| `FeeLevel` | type | Priority level used to look up a Bitcoin network fee rate. |
| `BitcoinSigner` | interface | Contract that a Bitcoin signing backend must implement so `PowPegSDK` can derive addresses and sign peg-in transactions with it. |
| `BitcoinDataSource` | interface | Contract for a Bitcoin data provider (fee rates, UTXOs, raw transactions, broadcasting). |
| `AddressWithDetails` | interface | A Bitcoin address together with its current balance and transaction count. |
| `Utxo` | interface | A spendable Bitcoin unspent transaction output. |
| `PegoutFeeEstimation` | interface | Estimated Bitcoin and Rootstock fees for a peg-out. |
| `TxType` | enum | Distinguishes a peg-in (BTC -> RBTC) from a peg-out (RBTC -> BTC) transaction. |
| `PegoutStatuses` | enum | Lifecycle status of a peg-out transaction, as reported by the 2WP API. |
| `PeginStatuses` | enum | Lifecycle status of a peg-in transaction, as reported by the 2WP API. |
| `RejectedPegoutReasons` | const | Maps the bridge's numeric rejection codes to a human-readable peg-out rejection reason. |
| `RejectedPegoutReason` | type | A human-readable reason a peg-out was rejected, as reported by the 2WP API. |
| `PeginTxDetails` | interface | Bitcoin and Rootstock-side details of a peg-in transaction. |
| `PegoutTxDetails` | interface | Details of a peg-out transaction, including its Bitcoin release once processed. |
| `PegoutStatusData` | interface | Status payload for a peg-out transaction, as returned by `PowPegSDK.getTransactionStatus`. |
| `PeginStatusData` | interface | Status payload for a peg-in transaction, as returned by `PowPegSDK.getTransactionStatus`. |
| `StatusData` | type | Discriminated union of the two possible `PowPegSDK.getTransactionStatus` payloads. |
| `UnsignedPegin` | interface | An unsigned, fee-funded peg-in PSBT ready to be signed, as returned by `PowPegSDK.createAndFundPegin`. |

## Errors (`src/errors.ts`)

| Export | Kind | Description |
|---|---|---|
| `AmountBelowMinError` | class | Thrown when a requested peg-in or peg-out amount is below the protocol's minimum allowed amount. |
| `NotEnoughFundsError` | class | Thrown when the available UTXOs/balance can't cover the requested amount plus fees. |
| `APIError` | class | Thrown when the 2WP API responds with an error, a failed request, or an unexpected failure. |
| `InvalidAddressError` | class | Thrown when one or more Bitcoin addresses don't belong to the SDK's configured network. |
