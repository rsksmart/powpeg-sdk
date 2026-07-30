import TrezorConnect, { PROTO } from '@trezor/connect-web'
import type { BitcoinSigner, Utxo } from '../../types'
import { Psbt } from 'bitcoinjs-lib'
import { getAddressType } from '../../utils'
import { supportedAddressTypes, networks, type AddressType, type Network } from '../../constants'

/**
 * A {@link BitcoinSigner} implementation backed by a Trezor hardware wallet via
 * `@trezor/connect-web`. Instances must be created with the static `init` method.
 */
export class TrezorSigner implements BitcoinSigner {
  private readonly bitcoinTxVersion = 1
  private readonly addresses = new Map<string, number[]>()

  private constructor(
    private readonly network: Network = 'TEST',
    private _addressType: AddressType = 'NATIVE SEGWIT',
  ) {}

  /**
   * Initializes the Trezor Connect SDK and creates a `TrezorSigner` for the given network.
   * @param {Network} network - The Bitcoin network to use. Defaults to 'TEST'.
   * @param {typeof TrezorConnect.init} initOptions - Options merged into the `TrezorConnect.init` call (overrides the default empty manifest).
   * @returns {Promise<TrezorSigner>} A signer ready to derive addresses and sign transactions.
   */
  static async init(network?: Network, initOptions?: typeof TrezorConnect.init) {
    await TrezorConnect.init({ manifest: { appUrl: '', email: '', appName: '' }, ...initOptions })
    return new TrezorSigner(network)
  }

  /**
   * Disposes the current Trezor Connect instance and re-initializes it with defaults.
   * @returns {Promise<TrezorSigner>} A fresh signer for the default ('TEST') network.
   */
  static async reinit() {
    TrezorConnect.dispose()
    return TrezorSigner.init()
  }

  /** Sets the address type used when deriving addresses and signing (e.g. 'NATIVE SEGWIT', 'SEGWIT', 'LEGACY'). */
  set addressType(addressType: AddressType) {
    this._addressType = addressType
  }

  /** The address type currently used when deriving addresses and signing. */
  get addressType() {
    return this._addressType
  }

  private getPathPurpose() {
    return supportedAddressTypes[this._addressType].path
  }

  private getPathCoin() {
    return networks[this.network].coin
  }

  private async getAddresses(bundleSize: number, change = false): Promise<string[]> {
    const addresses: string[] = []
    const bundle = Array.from(
      { length: bundleSize },
      (_, i) => ({ path: `m/${this.getPathPurpose()}'/${this.getPathCoin()}'/0'/${change ? '1' : '0'}/${i}`, showOnTrezor: false, coin: this.network }),
    )
    const result = await TrezorConnect.getAddress({ bundle })
    if (result.success) {
      result.payload.forEach(({ address, path }) => {
        this.addresses.set(address, path)
        addresses.push(address)
      })
    }
    return addresses
  }

  /**
   * Derives a bundle of change addresses from the connected Trezor device.
   * @param {number} bundleSize - The number of addresses to derive.
   * @returns {Promise<string[]>} The derived change addresses.
   */
  async getChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize, true)
  }

  /**
   * Derives a bundle of non-change (receiving) addresses from the connected Trezor device.
   * @param {number} bundleSize - The number of addresses to derive.
   * @returns {Promise<string[]>} The derived non-change addresses.
   */
  async getNonChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize)
  }

  private getScriptType(address: string) {
    const addressType = getAddressType(address, this.network)
    switch (addressType) {
      case 'SEGWIT':
        return 'SPENDP2SHWITNESS'
      case 'LEGACY':
        return 'SPENDADDRESS'
      case 'NATIVE SEGWIT':
        return 'SPENDWITNESS'
      default:
        return 'SPENDADDRESS'
    }
  }

  private getInputs(utxos: Utxo[]): PROTO.TxInputType[] {
    return utxos.map((utxo) => {
      return {
        address_n: this.addresses.get(utxo.address) ?? [],
        prev_hash: utxo.txid,
        prev_index: utxo.vout,
        script_type: this.getScriptType(utxo.address),
        amount: Number(utxo.amount),
      }
    })
  }

  private getOutputs(psbt: Psbt): PROTO.TxOutputType[] {
    return psbt.txOutputs.map((output) => {
      if (output.value === 0 && !output.address) {
        return {
          amount: output.value,
          op_return_data: output.script.toString('hex').slice(4),
          script_type: 'PAYTOOPRETURN',
        }
      }
      return {
        address: output.address ?? '',
        script_type: 'PAYTOADDRESS',
        amount: output.value,
      }
    })
  }

  /**
   * Signs a transaction with the connected Trezor device.
   * @param {Psbt} psbt - The PSBT whose outputs describe the transaction to sign.
   * @param {Utxo[]} utxos - The UTXOs being spent, used to build the Trezor input list.
   * @returns {Promise<string>} The serialized signed transaction hex, or an empty string if signing was not successful.
   */
  async signTransaction(psbt: Psbt, utxos: Utxo[]): Promise<string> {
    const inputs = this.getInputs(utxos)
    const outputs = this.getOutputs(psbt)
    const result = await TrezorConnect.signTransaction({
      coin: this.network,
      version: this.bitcoinTxVersion,
      inputs,
      outputs,
    })
    if (result.success) {
      return result.payload.serializedTx
    }
    return ''
  }
}
