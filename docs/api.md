# API Reference

Public exports of the package's entry point (`src/index.ts`). Each description is the first line of that symbol's TSDoc comment — see the linked source file for the full contract.

## SDK

| Export | Kind | Description |
|---|---|---|
| [`PowPegSDK`](../src/sdk/powpeg.ts) | class | SDK for creating, funding, signing and broadcasting native PowPeg peg-in (BTC -> RBTC) and peg-out (RBTC -> BTC) transactions. |

See [`PowPegSDK`](../src/sdk/powpeg.ts) for the full list of methods (`estimatePeginFee`, `createPegin`, `fundPegin`, `createAndFundPegin`, `createAndFundPsbt`, `signAndBroadcastPegin`, `estimatePegoutFees`, `createPegout`, `signAndBroadcastPegout`, `getTransactionStatus`, `getFeatures`, `getAvailableUtxos`) — each documented in place with its params and return type.

## Bitcoin signers

The package ships no `BitcoinSigner` implementations — see [`bitcoin-signers.md`](./bitcoin-signers.md) for the contract and how to supply your own.

## Types (`src/types.ts`)

| Export | Kind | Description |
|---|---|---|
| `Network` | type + value | `'MAIN'` or `'TEST'`. Exported as both, so `Network.TEST` can be used where a network is expected and `Network` can annotate configuration. |
| `PowPegSDKOptions` | interface | Configuration for `PowPegSDK`; only `network` is required. |
| `FeeLevel` | type | Priority level used to look up a Bitcoin network fee rate. |
| `BitcoinSigner` | interface | Contract that a Bitcoin signing backend must implement so `PowPegSDK` can derive addresses and sign peg-in transactions with it. |
| `BitcoinDataSource` | interface | Contract for a Bitcoin data provider (fee rates, UTXOs, raw transactions, broadcasting). |
| `AddressWithDetails` | interface | A Bitcoin address together with its current balance and transaction count. |
| `Utxo` | interface | A spendable Bitcoin unspent transaction output. |
| `Feature` | interface | A feature flag as reported by the 2WP API. |
| `SupportedBrowsers` | interface | Browser support flags carried by a `Feature`. |
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
| `InvalidAddressError` | class | Thrown when one or more addresses are invalid: a Bitcoin address that doesn't belong to the SDK's configured network, or a malformed Rootstock recipient address. |
| `FederationAddressError` | class | Thrown when the federation address can't be retrieved from the pegin configuration endpoint or doesn't match the Bridge contract's value. |
| `SigningError` | class | Thrown when the configured `BitcoinSigner` doesn't return what the SDK asked it for: no derived addresses, or no signed transaction to broadcast. |
| `PegoutRejectedError` | class | Thrown when the peg-out transaction was mined but the Bridge rejected the release request; carries `reason` (1 below minimum, 2 caller is a contract, 3 fee above value — 1 and 3 are refunded, 2 is not), `txHash` and `amount`. |
| `UnsupportedSenderError` | class | Thrown when the account asked to send a peg-out is a contract account, which the Bridge refuses to release BTC for. |
| `WrongNetworkError` | class | Thrown when the signer's chain doesn't match the network the SDK was configured for. |
| `InvalidFeeRateError` | class | Thrown when a fee rate from the configured `BitcoinDataSource` is missing, non-numeric, non-positive, exceeds the configured bound, or produces a fee disproportionate to the amount being sent. |
