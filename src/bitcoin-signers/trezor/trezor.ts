import TrezorConnect, { PROTO } from '@trezor/connect-web'
import type { BitcoinSigner, Utxo } from '../../types'
import { Psbt } from 'bitcoinjs-lib'
import { getAddressType } from '../../utils'
import { supportedAddressTypes, networks, type AddressType, type Network } from '../../constants'

export class TrezorSigner implements BitcoinSigner {
  private readonly bitcoinTxVersion = 1
  private readonly addresses = new Map<string, number[]>()

  private constructor(
    private readonly network: Network = 'TEST',
    private _addressType: AddressType = 'NATIVE SEGWIT',
  ) {}

  static async init(network?: Network, initOptions?: typeof TrezorConnect.init) {
    await TrezorConnect.init({ manifest: { appUrl: '', email: '' }, ...initOptions })
    return new TrezorSigner(network)
  }

  static async reinit() {
    TrezorConnect.dispose()
    return TrezorSigner.init()
  }

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

  async getChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize, true)
  }

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
