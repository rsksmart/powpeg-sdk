import Btc from '@ledgerhq/hw-app-btc'
import type Transport from '@ledgerhq/hw-transport'
import TransportWebUSB from '@ledgerhq/hw-transport-webusb'
import type { BitcoinSigner, Utxo } from '../types'
import { deriveAddress, sleep } from '../utils'
import { Transaction, type Psbt } from 'bitcoinjs-lib'
import type { Transaction as LedgerTransaction } from '@ledgerhq/hw-app-btc/lib/types'
import type { CreateTransactionArg } from '@ledgerhq/hw-app-btc/lib/createTransaction'
import { supportedAddressTypes, networks, type AddressType, type Network } from '../constants'

export class LedgerSigner implements BitcoinSigner {
  private addresses = new Map<string, string>()

  private constructor(
    private connection: Btc,
    private transport: Transport,
    private network: Network,
    private _addressType: AddressType = 'NATIVE SEGWIT',
  ) {}

  static async init(network: Network = 'TEST'): Promise<LedgerSigner> {
    const transport = await TransportWebUSB.create()
    const connection = new Btc({ transport, currency: networks[network].currency })
    return new LedgerSigner(connection, transport, network)
  }

  async reinit() {
    await this.transport.close()
    return LedgerSigner.init()
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

  private getAddressFormat() {
    return supportedAddressTypes[this._addressType].format
  }

  private getXpubVersion() {
    return networks[this.network].xpubVersion
  }

  private isSegwit() {
    return this._addressType === 'SEGWIT' || this._addressType === 'NATIVE SEGWIT'
  }

  private isDeviceBusy() {
    return this.transport._appAPIlock
  }

  async getAddresses(bundleSize: number, change = false): Promise<string[]> {
    if (this.isDeviceBusy()) {
      await sleep(5000)
      return this.getAddresses(bundleSize, change)
    }
    const addresses: string[] = []
    const basePath = `m/${this.getPathPurpose()}'/${this.getPathCoin()}'/0'/${change ? '1' : '0'}`
    const xpub = await this.connection.getWalletXpub({ path: basePath, xpubVersion: this.getXpubVersion() })
    for (let i = 0; i < bundleSize; i++) {
      const path = `${basePath}/${i}`
      const address = deriveAddress(xpub, i, this.addressType, this.network)
      if (address) {
        addresses.push(address)
        this.addresses.set(address, path)
      }
    }
    return addresses
  }

  async getChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize, true)
  }

  async getNonChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize)
  }

  getInputs(inputs: Utxo[], transactions: string[]): CreateTransactionArg['inputs'] {
    return inputs.map((input, index) => {
      const txHex = transactions[index]
      const tx = Transaction.fromHex(txHex)
      const deserializedTx = this.connection.splitTransaction(txHex, tx.hasWitnesses())
      return [deserializedTx, input.vout, undefined, undefined]
    })
  }

  getOutputScriptHex(psbt: Psbt) {
    const outputs = psbt.txOutputs.map((output) => {
      const amount = Buffer.alloc(8)
      amount.writeBigUInt64LE(BigInt(output.value))
      return {
        script: output.script,
        amount,
      }
    })
    return this.connection.serializeTransactionOutputs({ outputs } as LedgerTransaction).toString('hex')
  }

  async signTransaction(psbt: Psbt, inputs: Utxo[], transactions: string[]): Promise<string> {
    const ledgerInputs = this.getInputs(inputs, transactions)
    const paths = inputs.map((input) => this.addresses.get(input.address)).filter((item): item is string => !!item)
    const outputScriptHex = this.getOutputScriptHex(psbt)
    return this.connection.createPaymentTransaction({
      inputs: ledgerInputs,
      associatedKeysets: paths,
      outputScriptHex,
      segwit: this.isSegwit(),
      useTrustedInputForSegwit: this.isSegwit(),
      additionals: this.getAddressFormat() === 'bech32' ? ['bech32'] : [],
    })
  }
}
