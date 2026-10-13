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
  getPublicKey?(address: string): Promise<string | undefined>
}
```

- `getNonChangeAddresses` / `getChangeAddresses` — derive `bundleSize` receive/change addresses the signer controls. `PowPegSDK` uses these to find funded addresses and an unused refund/change address.
- `signTransaction` — signs a peg-in PSBT and returns the serialized signed transaction. `inputs`/`transactions` carry the UTXOs being spent and their raw hex, for signers that need to verify each input against its funding transaction. **Throw on failure rather than returning an empty string** — a user declining on a device and a backend outage are different events, and an empty return is rejected with `SigningError` rather than broadcast.
- `getPublicKey` (optional) — returns the compressed public key, as 66 hex characters, behind one of the signer's P2SH-P2WPKH (nested segwit) addresses, or `undefined` if it doesn't know it. Implement it to let peg-ins be funded from nested segwit addresses; see below.

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
| `'SEGWIT'` | BIP 49 | `49'` | P2SH-wrapped P2WPKH (`3…` / `2…`) | supported if the signer implements `getPublicKey` |
| `'NATIVE SEGWIT'` | BIP 84 | `84'` | P2WPKH (`bc1…` / `tb1…`) | supported |

Funding is allowed for P2PKH, P2WPKH and P2SH-P2WPKH scripts and nothing else, decided from the UTXO's
own `scriptPubKey` rather than from the shape of the address. That distinction matters for bech32: a P2WSH
and a taproot address look like a P2WPKH one, and only the script tells them apart.

### Nested segwit (P2SH-P2WPKH)

A P2SH input can only be signed with the redeem script behind the address, which is derived from the
public key. For each P2SH UTXO, `fundPegin` asks the signer bound to the PSBT for that key with
`getPublicKey(address)` — `address` is the one the UTXO's script encodes — builds the P2WPKH redeem
script from it, and adds the input only if hashing that script reproduces the P2SH hash being spent. The
input then carries `redeemScript` and `witnessUtxo`, plus the parent transaction in `nonWitnessUtxo`, so a
signer built on bitcoinjs-lib can sign and finalize it without adding anything.

`fundPegin` throws `UnsupportedAddressTypeError` naming the address when the signer doesn't implement
`getPublicKey`, returns `undefined`, returns anything but a compressed public key, or returns a key whose
P2SH-P2WPKH script doesn't match — which is also what any other P2SH script, such as a multisig or a
P2SH-P2WSH, gets. Each address is asked once per `fundPegin` call, in input order, and an error thrown by
`getPublicKey` propagates unchanged. A PSBT from `createAndFundPsbt` without a `signer` has no signer to
ask, so its P2SH UTXOs are refused too.

### Unsupported scripts

A UTXO held by any other script — P2WSH, taproot, a bare multisig — is refused the same way. Each needs a
redeem script, a witness script or a key that `BitcoinSigner` does not expose, so the SDK cannot build a
complete PSBT input for it. Fund from a legacy, nested segwit or native segwit address, or pass
`selectedUtxos` that exclude the UTXO. Every check runs before the PSBT is touched, so a refused UTXO
leaves it exactly as `createPegin` returned it — no inputs added, no change output, and still fundable.

When `createPegin` discovers UTXOs itself, it looks only at the signer's legacy and native segwit
addresses, plus its nested segwit ones when the signer implements `getPublicKey`, so a wallet holding
several types funds a peg-in from the part the SDK can sign. If what remains
does not cover the amount, `NotEnoughFundsError` says how much was left out. The same preference applies
to the change address: change goes to the first unused change address the SDK could fund from later,
falling back to the first unused one, and then to the first funding input's address. `UnsupportedAddressTypeError`
is therefore reserved for a UTXO the caller named in `selectedUtxos`.

Every funding input carries `witnessUtxo`. A legacy or nested segwit input also carries
`nonWitnessUtxo`, the full parent transaction; a native segwit input is signed from `witnessUtxo` alone and
does not carry it. So a signer built on bitcoinjs-lib can sign any supported type without fetching
anything itself.

### Refund address

`createPegin` writes the first unused address from `getNonChangeAddresses` into the peg-in's `OP_RETURN`
as its refund address, but only when it is P2PKH or P2SH: those are the only types the Bridge's peg-in
protocol can encode. When that address is native segwit or taproot, or every address is used, the
`OP_RETURN` carries no refund address, and the peg-in is still valid. Without one, the Bridge falls back to
the sender of the first input when it is P2PKH or P2SH-P2WPKH.

Coin type is `0'` on `MAIN` and `1'` on `TEST`, so a full account path reads
`m/84'/1'/0'/0/<index>` for a native-segwit receive address on testnet, and `.../1/<index>` for a change
address. Extended public keys use version bytes `0x0488b21e` on `MAIN` and `0x043587cf` on `TEST`.

Whatever the type, keep the mapping stable: the same address must resolve to the same derivation path
across calls, since a signer is asked for its addresses and later asked to sign the inputs they own.

A signer that exposes no change addresses is fine — the refund entry is optional and funding falls back
to an input's own address. A signer that derives nothing at all can still be used by passing
`selectedUtxos` to `createPegin`, which skips address-based UTXO discovery entirely.
