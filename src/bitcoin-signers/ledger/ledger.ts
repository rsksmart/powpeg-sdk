import Btc from '@ledgerhq/hw-app-btc'
import type Transport from '@ledgerhq/hw-transport'
import TransportWebUSB from '@ledgerhq/hw-transport-webusb'
import type { BitcoinSigner, Utxo } from '../../types'
import { assertTruthy } from '@rsksmart/bridges-core-sdk'
import { deriveAddress } from '../../utils'
import { Transaction, type Psbt } from 'bitcoinjs-lib'
import type { Transaction as LedgerTransaction } from '@ledgerhq/hw-app-btc/lib/types'
import type { CreateTransactionArg } from '@ledgerhq/hw-app-btc/lib/createTransaction'
import { supportedAddressTypes, networks, type AddressType, type Network } from '../../constants'
import { LedgerTransportService } from './ledger-transport'

/**
 * {@link BitcoinSigner} backed by a Ledger hardware wallet, connected over WebUSB.
 * Device operations are queued so only one runs against the transport at a time.
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
   * Opens a WebUSB transport to a connected Ledger device and returns a ready-to-use signer.
   * @param {Network} [network] - The network to derive addresses for. Defaults to `'TEST'`.
   * @returns {Promise<LedgerSigner>} The initialized signer.
   */
  static async init(network: Network = 'TEST'): Promise<LedgerSigner> {
    const transport = await TransportWebUSB.create()
    const connection = new Btc({ transport, currency: networks[network].currency })
    return new LedgerSigner(connection, transport, network)
  }

  /**
   * Closes and reopens the WebUSB transport to the Ledger device, queued behind any in-flight operation.
   * @returns {Promise<LedgerSigner>} A freshly initialized signer for the default (`'TEST'`) network.
   */
  async reinit() {
    return this.transportService.enqueue(async () => {
      await this.transport.close()
      return LedgerSigner.init()
    })
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

  private getAddressFormat() {
    return supportedAddressTypes[this._addressType].format
  }

  private getXpubVersion() {
    return networks[this.network].xpubVersion
  }

  private isSegwit() {
    return this._addressType === 'SEGWIT' || this._addressType === 'NATIVE SEGWIT'
  }

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
   * @param {number} bundleSize - Number of change addresses to derive.
   * @returns {Promise<string[]>} `bundleSize` change addresses derived from the Ledger device.
   */
  async getChangeAddresses(bundleSize: number): Promise<string[]> {
    return this.getAddresses(bundleSize, true)
  }

  /**
   * @param {number} bundleSize - Number of receive addresses to derive.
   * @returns {Promise<string[]>} `bundleSize` receive (non-change) addresses derived from the Ledger device.
   */
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

  private isChangePath(path: string) {
    const segments = path.split('/')
    return segments.length === 6 && segments[4] === '1'
  }

  private getChangePath(psbt: Psbt): string | undefined {
    for (const output of psbt.txOutputs) {
      if (!output.address) continue
      const path = this.addresses.get(output.address)
      if (path && this.isChangePath(path)) {
        return path
      }
    }
    return undefined
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

  /**
   * Signs the given PSBT on the Ledger device, queued behind any in-flight operation.
   * @param {Psbt} psbt - The PSBT to sign.
   * @param {Utxo[]} [inputs] - The PSBT's inputs, used to look up each input's previously derived address path. Required — LedgerSigner cannot sign from the PSBT alone.
   * @param {string[]} [transactions] - Raw hex transactions for `inputs`, required by the Ledger app to verify each input.
   * @returns {Promise<string>} The signed, serialized transaction.
   */
  async signTransaction(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string> {
    assertTruthy(inputs, "LedgerSigner.signTransaction requires inputs to look up each UTXO's derived address path")
    assertTruthy(transactions, 'LedgerSigner.signTransaction requires the raw hex transactions for each input')
    return this.transportService.enqueue(async () => {
      const ledgerInputs = this.getInputs(inputs, transactions)
      const paths = inputs.map((input) => this.addresses.get(input.address)).filter((item): item is string => !!item)
      const outputScriptHex = this.getOutputScriptHex(psbt)
      const changePath = this.getChangePath(psbt)
      return this.connection.createPaymentTransaction({
        inputs: ledgerInputs,
        associatedKeysets: paths,
        outputScriptHex,
        // hw-app-btc throws if changePath matches no output, so omit it
        // when the transaction has no device-derived change output
        ...(changePath ? { changePath } : {}),
        segwit: this.isSegwit(),
        useTrustedInputForSegwit: this.isSegwit(),
        additionals: this.getAddressFormat() === 'bech32' ? ['bech32'] : [],
      })
    })
  }
}
