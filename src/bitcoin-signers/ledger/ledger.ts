import Btc from '@ledgerhq/hw-app-btc'
import type Transport from '@ledgerhq/hw-transport'
import TransportWebUSB from '@ledgerhq/hw-transport-webusb'
import type { BitcoinSigner, Utxo } from '../../types'
import { deriveAddress } from '../../utils'
import { Transaction, type Psbt } from 'bitcoinjs-lib'
import type { Transaction as LedgerTransaction } from '@ledgerhq/hw-app-btc/lib/types'
import type { CreateTransactionArg } from '@ledgerhq/hw-app-btc/lib/createTransaction'
import { supportedAddressTypes, networks, type AddressType, type Network } from '../../constants'
import { LedgerTransportService } from './ledger-transport'

/**
 * A {@link BitcoinSigner} implementation backed by a Ledger hardware wallet over WebUSB.
 * Instances must be created with the static `init` method. Device operations are queued
 * and run one at a time.
 */
export class LedgerSigner implements BitcoinSigner {
  private readonly addresses = new Map<string, string>()
  private readonly transportService: LedgerTransportService

  private constructor(
    private readonly connection: Btc,
    private readonly transport: Transport,
    private readonly network: Network,
    private _addressType: AddressType = 'NATIVE SEGWIT',
  ) {
    this.transportService = new LedgerTransportService(transport)
  }

  /**
   * Opens a WebUSB connection to a Ledger device and creates a `LedgerSigner` for the given network.
   * @param {Network} network - The Bitcoin network to use. Defaults to 'TEST'.
   * @returns {Promise<LedgerSigner>} A signer ready to derive addresses and sign transactions.
   */
  static async init(network: Network = 'TEST'): Promise<LedgerSigner> {
    const transport = await TransportWebUSB.create()
    const connection = new Btc({ transport, currency: networks[network].currency })
    return new LedgerSigner(connection, transport, network)
  }

  /**
   * Closes the current transport and opens a new WebUSB connection for the default ('TEST') network.
   * @returns {Promise<LedgerSigner>} A fresh signer.
   */
  async reinit() {
    return this.transportService.enqueue(async () => {
      await this.transport.close()
      return LedgerSigner.init()
    })
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

  private getAddressFormat() {
    return supportedAddressTypes[this._addressType].format
  }

  private getXpubVersion() {
    return networks[this.network].xpubVersion
  }

  private isSegwit() {
    return this._addressType === 'SEGWIT' || this._addressType === 'NATIVE SEGWIT'
  }

  /**
   * Derives a bundle of addresses from the connected Ledger device.
   * @param {number} bundleSize - The number of addresses to derive.
   * @param {boolean} change - Whether to derive change addresses (path index 1) instead of non-change (path index 0). Defaults to false.
   * @returns {Promise<string[]>} The derived addresses.
   */
  async getAddresses(bundleSize: number, change = false): Promise<string[]> {
    return this.transportService.enqueue(async () => {
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
    })
  }

  /**
   * Derives a bundle of change addresses from the connected Ledger device.
   * @param {number} bundleSize - The number of addresses to derive.
   * @returns {Promise<string[]>} The derived change addresses.
   */
  async getChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize, true)
  }

  /**
   * Derives a bundle of non-change (receiving) addresses from the connected Ledger device.
   * @param {number} bundleSize - The number of addresses to derive.
   * @returns {Promise<string[]>} The derived non-change addresses.
   */
  async getNonChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize)
  }

  /**
   * Builds the Ledger-formatted input list for a transaction, by splitting each input's raw
   * transaction into the format expected by `@ledgerhq/hw-app-btc`.
   * @param {Utxo[]} inputs - The UTXOs being spent.
   * @param {string[]} transactions - The raw hex transactions corresponding to each input, in the same order.
   * @returns {CreateTransactionArg['inputs']} The Ledger-formatted inputs, ready for `createPaymentTransaction`.
   */
  getInputs(inputs: Utxo[], transactions: string[]): CreateTransactionArg['inputs'] {
    return inputs.map((input, index) => {
      const txHex = transactions[index]
      const tx = Transaction.fromHex(txHex)
      const deserializedTx = this.connection.splitTransaction(txHex, tx.hasWitnesses())
      return [deserializedTx, input.vout, undefined, undefined]
    })
  }

  /**
   * Serializes a PSBT's outputs into the hex format expected by the Ledger device.
   * @param {Psbt} psbt - The PSBT whose outputs will be serialized.
   * @returns {string} The serialized output script, as a hex string.
   */
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

  /**
   * Signs a transaction with the connected Ledger device.
   * @param {Psbt} psbt - The PSBT whose outputs describe the transaction to sign.
   * @param {Utxo[]} inputs - The UTXOs being spent.
   * @param {string[]} transactions - The raw hex transactions corresponding to each input, in the same order.
   * @returns {Promise<string>} The signed, serialized payment transaction.
   */
  async signTransaction(psbt: Psbt, inputs: Utxo[], transactions: string[]): Promise<string> {
    return this.transportService.enqueue(async () => {
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
    })
  }
}
