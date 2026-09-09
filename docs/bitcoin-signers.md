# Bitcoin signers

`PowPegSDK` doesn't sign transactions itself — it delegates address derivation and PSBT signing to a `BitcoinSigner`, so any Bitcoin key-management backend (hardware wallet, custom key store, etc.) can be plugged in.

The package ships no `BitcoinSigner` implementations; supplying one is up to the consumer.

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
- `signTransaction` — signs a peg-in PSBT and returns the serialized signed transaction. `inputs`/`transactions` carry the UTXOs being spent and their raw hex, for signers that need to verify each input against its funding transaction.

## Adding a signer

1. Create a class implementing `BitcoinSigner`.
2. Keep vendor SDK/transport specifics (e.g. a hardware wallet's connection library) private to the class; expose only what the `BitcoinSigner` contract requires plus any signer-specific setup — an async `init` factory, if construction needs to await a connection.
3. Pass an instance to `PowPegSDK`'s constructor (as `_bitcoinSigner`), to `createAndFundPegin(...)`'s `signer` argument, or to `createAndFundPsbt(...)`'s `signer` argument. Whichever PSBT-creating method is used, `signAndBroadcastPegin` signs with the signer bound to that specific PSBT — a PSBT created without one cannot be signed later by setting the constructor-level signer alone.

Addresses passed to `PowPegSDK` may be `'LEGACY'`, `'SEGWIT'` or `'NATIVE SEGWIT'`; deriving them at the chosen type is the signer's responsibility.
