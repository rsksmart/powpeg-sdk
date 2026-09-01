# Bitcoin signers

`PowPegSDK` doesn't sign transactions itself — it delegates address derivation and PSBT signing to a `BitcoinSigner`, so any Bitcoin key-management backend (hardware wallet, custom key store, etc.) can be plugged in.

## The contract

Defined in [`src/types.ts`](../src/types.ts):

```ts
export interface BitcoinSigner {
  getNonChangeAddresses(bundleSize: number): Promise<string[]>
  getChangeAddresses(bundleSize: number): Promise<string[]>
  signTransaction(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string>
}
```

- `getNonChangeAddresses` / `getChangeAddresses` — derive `bundleSize` receive/change addresses the signer controls. `PowPegSDK` uses these to find funded addresses and an unused refund/change address.
- `signTransaction` — signs a peg-in PSBT and returns the serialized signed transaction. `inputs`/`transactions` carry the UTXOs being spent and their raw hex, for signers (like Ledger) that need to verify each input.

## Existing implementations

| Implementation | Location | Description |
|---|---|---|
| `TrezorSigner` | [`src/bitcoin-signers/trezor/trezor.ts`](../src/bitcoin-signers/trezor/trezor.ts) | Backed by a Trezor hardware wallet, connected via `@trezor/connect-web`. Initialized with the async `TrezorSigner.init(network?)` factory (constructor is private). |
| `LedgerSigner` | [`src/bitcoin-signers/ledger/ledger.ts`](../src/bitcoin-signers/ledger/ledger.ts) | Backed by a Ledger hardware wallet, connected over WebUSB (`@ledgerhq/hw-transport-webusb`). Initialized with the async `LedgerSigner.init(network?)` factory. Queues device operations through `LedgerTransportService` so only one runs against the transport at a time. |

Both support `'LEGACY'`, `'SEGWIT'` and `'NATIVE SEGWIT'` address types via their `addressType` getter/setter (see `supportedAddressTypes` and `networks` in [`src/constants.ts`](../src/constants.ts) for the derivation paths and network params behind each).

## Adding a new signer

Following the pattern of the two existing implementations:

1. Create a new file under `src/bitcoin-signers/<name>/<name>.ts` implementing `BitcoinSigner`.
2. Keep vendor SDK/transport specifics (e.g. a hardware wallet's connection library) private to the class; expose only what the `BitcoinSigner` contract requires plus any signer-specific setup (e.g. an async `init` factory, as both existing signers do, if construction needs to await a connection).
3. Pass an instance to `PowPegSDK`'s constructor (as `_bitcoinSigner`), to `createAndFundPegin(...)`'s `signer` argument, or to `createAndFundPsbt(...)`'s `signer` argument. Whichever PSBT-creating method is used, `signAndBroadcastPegin` signs with the signer bound to that specific PSBT — a PSBT created without one cannot be signed later by setting the constructor-level signer alone.
4. Re-export the new class from [`src/index.ts`](../src/index.ts) if it's meant to be part of the public package surface.
