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
- `signTransaction` — signs a peg-in PSBT and returns the serialized signed transaction. `inputs`/`transactions` carry the UTXOs being spent and their raw hex, for signers that need to verify each input against its funding transaction. **Throw on failure rather than returning an empty string** — a user declining on a device and a backend outage are different events, and an empty return is rejected with `SigningError` rather than broadcast.

## Adding a signer

1. Create a class implementing `BitcoinSigner`.
2. Keep vendor SDK/transport specifics (e.g. a hardware wallet's connection library) private to the class; expose only what the `BitcoinSigner` contract requires plus any signer-specific setup — an async `init` factory, if construction needs to await a connection.
3. Pass an instance to `PowPegSDK`'s constructor (as the `bitcoinSigner` option), to `createAndFundPegin(...)`'s `signer` argument, or to `createAndFundPsbt(...)`'s `signer` argument. Whichever PSBT-creating method is used, `signAndBroadcastPegin` signs with the signer bound to that specific PSBT — a PSBT created without one cannot be signed later by setting the constructor-level signer alone.

## Address types and derivation

Addresses passed to `PowPegSDK` may be `'LEGACY'`, `'SEGWIT'` or `'NATIVE SEGWIT'`; deriving them at the
chosen type is the signer's responsibility. The values the SDK expects for each, and whether a peg-in can
be funded from UTXOs the address holds:

| Address type | BIP | Purpose (`m/<purpose>'`) | Address format | Funding a peg-in |
|---|---|---|---|---|
| `'LEGACY'` | BIP 44 | `44'` | P2PKH (`1…` / `m…`, `n…`) | supported |
| `'SEGWIT'` | BIP 49 | `49'` | P2SH-wrapped P2WPKH (`3…` / `2…`) | **not supported** |
| `'NATIVE SEGWIT'` | BIP 84 | `84'` | P2WPKH (`bc1…` / `tb1…`) | supported |

A P2SH input can only be signed with the redeem script behind the address, which is derived from the
public key. `BitcoinSigner` exposes addresses and a signing method, not public keys, so the SDK cannot
build that input. Rather than hand back a PSBT that fails later inside the signer, `fundPegin` throws
`UnsupportedAddressTypeError` naming the address. Fund from a legacy or native segwit address, or pass
`selectedUtxos` that exclude the UTXO. The check runs before the PSBT is touched, so a refused UTXO
leaves it exactly as `createPegin` returned it — no inputs added, no change output, and still fundable.

Every funding input carries `witnessUtxo`. A legacy input also carries `nonWitnessUtxo`, the full parent
transaction, because it cannot be signed without it; a witness input does not, since it is signed from
`witnessUtxo` alone and embedding the parent would add its entire size to the PSBT for nothing. So a
signer built on bitcoinjs-lib can sign either supported type without fetching anything itself.

Coin type is `0'` on `MAIN` and `1'` on `TEST`, so a full account path reads
`m/84'/1'/0'/0/<index>` for a native-segwit receive address on testnet, and `.../1/<index>` for a change
address. Extended public keys use version bytes `0x0488b21e` on `MAIN` and `0x043587cf` on `TEST`.

Whatever the type, keep the mapping stable: the same address must resolve to the same derivation path
across calls, since a signer is asked for its addresses and later asked to sign the inputs they own.

A signer that exposes no change addresses is fine — the refund entry is optional and funding falls back
to an input's own address. A signer that derives nothing at all can still be used by passing
`selectedUtxos` to `createPegin`, which skips address-based UTXO discovery entirely.
