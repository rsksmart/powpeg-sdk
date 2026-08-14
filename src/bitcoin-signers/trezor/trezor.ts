import TrezorConnect, { PROTO } from '@trezor/connect-web'
import type { BitcoinSigner, Utxo } from '../../types'
import { assertTruthy } from '@rsksmart/bridges-core-sdk'
import { Psbt } from 'bitcoinjs-lib'
import { getAddressType } from '../../utils'
import { supportedAddressTypes, networks, type AddressType, type Network } from '../../constants'

/** {@link BitcoinSigner} backed by a Trezor hardware wallet, connected via `@trezor/connect-web`. */
export class TrezorSigner implements BitcoinSigner {
  private readonly bitcoinTxVersion = 1
  private readonly addresses = new Map<string, number[]>()

  private constructor(
    private readonly network: Network = 'TEST',
    private _addressType: AddressType = 'NATIVE SEGWIT',
  ) {}

  /**
   * Initializes the Trezor connection and returns a ready-to-use signer.
   * @param {Network} [network] - The network to derive addresses for. Defaults to `'TEST'`.
   * @param {Partial<Parameters<typeof TrezorConnect.init>[0]>} [initOptions] - Extra options merged into the `TrezorConnect.init` call.
   * @returns {Promise<TrezorSigner>} The initialized signer.
   */
  static async init(network?: Network, initOptions?: Partial<Parameters<typeof TrezorConnect.init>[0]>) {
    await TrezorConnect.init({ manifest: { appUrl: '', email: '', appName: '' }, ...initOptions })
    return new TrezorSigner(network)
  }

  /**
   * Disposes the current Trezor connection and re-initializes it.
   * @returns {Promise<TrezorSigner>} A freshly initialized signer for the default (`'TEST'`) network.
   */
  static async reinit() {
    TrezorConnect.dispose()
    return TrezorSigner.init()
  }

  /** The Bitcoin address type used to derive addresses (`'LEGACY'`, `'SEGWIT'` or `'NATIVE SEGWIT'`). */
  set addressType(addressType: AddressType) {
    this._addressType = addressType
  }

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
   * @param {number} bundleSize - Number of change addresses to derive.
   * @returns {Promise<string[]>} `bundleSize` change addresses derived from the Trezor device.
   */
  async getChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize, true)
  }

  /**
   * @param {number} bundleSize - Number of receive addresses to derive.
   * @returns {Promise<string[]>} `bundleSize` receive (non-change) addresses derived from the Trezor device.
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

  private getOutputScriptType(address: string): 'PAYTOADDRESS' | 'PAYTOP2SHWITNESS' | 'PAYTOWITNESS' {
    const addressType = getAddressType(address, this.network)
    switch (addressType) {
      case 'SEGWIT':
        return 'PAYTOP2SHWITNESS'
      case 'NATIVE SEGWIT':
        return 'PAYTOWITNESS'
      default:
        return 'PAYTOADDRESS'
    }
  }

  private isChangePath(path: number[]) {
    return path.length === 5 && path[3] === 1
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
      const path = output.address ? this.addresses.get(output.address) : undefined
      // Only change outputs are marked as internal (address_n); receive
      // addresses stay as regular outputs so the device displays them.
      if (output.address && path && this.isChangePath(path)) {
        return {
          address_n: path,
          script_type: this.getOutputScriptType(output.address),
          amount: output.value,
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
   * Signs the given PSBT's inputs/outputs on the Trezor device.
   * @param {Psbt} psbt - The PSBT to sign.
   * @param {Utxo[]} [utxos] - The PSBT's inputs, used to look up each input's derivation path and script type. Required — TrezorSigner cannot sign from the PSBT alone.
   * @returns {Promise<string>} The serialized signed transaction, or an empty string if signing didn't succeed.
   */
  async signTransaction(psbt: Psbt, utxos?: Utxo[]): Promise<string> {
    assertTruthy(utxos, 'TrezorSigner.signTransaction requires utxos to look up input derivation paths')
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
