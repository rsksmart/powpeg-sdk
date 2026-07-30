import { address, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import type { BitcoinDataSource, BitcoinSigner, Utxo, FeeLevel, AddressWithDetails, PegoutFeeEstimation, TxType, UnsignedPegin } from '../types'
import { networks, type Network } from '../constants'
import { getAddressType, remove0x } from '../utils'
import { Bridge } from '../bridge'
import { ApiService } from '../api/api'
import * as sdkErrors from '../errors'
import { assertTruthy, ethers } from '@rsksmart/bridges-core-sdk'

/**
 * Main entry point for creating and broadcasting native PowPeg peg-in (BTC -> RSK) and
 * peg-out (RSK -> BTC) transactions.
 */
export class PowPegSDK {
  private txHeaderSizeInBytes = 13
  private txOutputSizeInBytes = 32
  private txInputSizeInBytes = 145
  private pegInOutputs = 3
  private powpegRsktHeader = '52534b5401'
  private burnDustMaxValue = 30_000
  private utxos: Utxo[] = []
  private changeAddress?: string
  private minPeginAmount = 500_000n
  private peginFeeEstimationInputs = 2
  private minPegoutAmount = '0.004'
  private btcNetworkConfig: typeof networks[Network]
  private bridge: Bridge
  private api: ApiService
  private rskProvider: ethers.providers.Provider
  private publicNodes: Record<Network, string> = {
    MAIN: 'https://public-node.rsk.co',
    TEST: 'https://public-node.testnet.rsk.co',
  }

  /**
   * @param {BitcoinSigner | null} _bitcoinSigner - An instance of a class that implements the BitcoinSigner interface.
   * @param {BitcoinDataSource | null} _bitcoinDataSource - An instance of a class that implements the BitcoinDataSource interface or null if you won't use peg-in operations.
   * @param {Network} network - The network to use. Either 'MAIN' or 'TEST'.
   * @param {string} rpcProviderUrl - URL of either your own Rootstock node, the Rootstock RPC API or a third-party node provider. If not provided, it will default to the Rootstock public node for the specified network.
   * @param {string} apiUrl - The URL of the API to use. If not provided, it will default to the production 2WP API URL for the specified network and use it as BitcoinDataSource.
   * @param {number} maxBundleSize - The maximum number of addresses to ask for while creating a peg-in transaction. Defaults to 10.
   * @param {number} burnDustValue - The value in satoshis to consider as dust to burn. Defaults to 2000.
   */
  constructor(
    private _bitcoinSigner: BitcoinSigner | null,
    private _bitcoinDataSource: BitcoinDataSource | null,
    private network: Network,
    rpcProviderUrl?: string,
    apiUrl?: string,
    private maxBundleSize = 10,
    private burnDustValue = 2000,
  ) {
    this.btcNetworkConfig = networks[network]
    this.rskProvider = new ethers.providers.JsonRpcProvider(rpcProviderUrl ?? this.publicNodes[network])
    this.bridge = new Bridge(this.rskProvider)
    this.api = new ApiService(network, apiUrl)
  }

  private get bitcoinSigner() {
    assertTruthy(this._bitcoinSigner, 'Bitcoin signer is required')
    return this._bitcoinSigner
  }

  private set bitcoinSigner(signer: BitcoinSigner) {
    this._bitcoinSigner = signer
  }

  private get bitcoinDataSource() {
    return this._bitcoinDataSource ?? this.api
  }

  private async getUtxos(addresses: string[] | AddressWithDetails[]): Promise<Utxo[]> {
    const rawAddresses = addresses.map((address) => typeof address === 'string' ? address : address.address)
    const utxoLists = await Promise.all(rawAddresses.map((address) => this.bitcoinDataSource.getOutputs(address)))
    const allUtxos = utxoLists.flat()

    const seen = new Set<string>()
    const uniqueUtxos = allUtxos.filter((utxo) => {
      const key = `${utxo.txid}:${utxo.vout}`
      if (seen.has(key)) {
        // eslint-disable-next-line no-console
        console.warn(`[PowPegSDK] Duplicate UTXO detected and skipped: ${key}`)
        return false
      }
      seen.add(key)
      return true
    })

    return uniqueUtxos
  }

  private async getAddressesWithDetails(addresses: string[]) {
    return Promise.all(addresses.map((address) => this.bitcoinDataSource.getAddressDetails(address)))
  }

  private groupAddressesByUsage(addresses: AddressWithDetails[]) {
    const used: AddressWithDetails[] = []
    const unused: AddressWithDetails[] = []
    addresses.forEach((address) => {
      if (address.txCount > 0) {
        used.push(address)
      }
      else {
        unused.push(address)
      }
    })
    return { used, unused }
  }

  private groupAddressesByBalance(addresses: AddressWithDetails[]) {
    const withBalance: AddressWithDetails[] = []
    const withoutBalance: AddressWithDetails[] = []
    addresses.forEach((address) => {
      if (address.balance > 0) {
        withBalance.push(address)
      }
      else {
        withoutBalance.push(address)
      }
    })
    return { withBalance, withoutBalance }
  }

  private async getAddressesGroupedByUsage() {
    const nonChangeAddresses = await this.bitcoinSigner.getNonChangeAddresses(this.maxBundleSize)
    const changeAddresses = await this.bitcoinSigner.getChangeAddresses(this.maxBundleSize)
    const [nonChangeDetails, changeDetails] = await Promise.all([
      this.getAddressesWithDetails(nonChangeAddresses),
      this.getAddressesWithDetails(changeAddresses),
    ])
    return {
      nonChange: this.groupAddressesByUsage(nonChangeDetails),
      change: this.groupAddressesByUsage(changeDetails),
    }
  }

  private getRskOutput(recipientAddress: string, refundAddress?: string) {
    let output = `${this.powpegRsktHeader}${remove0x(recipientAddress)}`
    if (refundAddress) {
      const refundAddressType = getAddressType(refundAddress, this.network)
      const prefixes = {
        LEGACY: '01',
        SEGWIT: '02',
      }
      if (refundAddressType === 'LEGACY' || refundAddressType === 'SEGWIT') {
        const hash = address.fromBase58Check(refundAddress).hash.toString('hex')
        output += `${prefixes[refundAddressType]}${hash}`
      }
    }
    return Buffer.from(output, 'hex')
  }

  /**
   * Estimates the total Bitcoin network fee (in satoshis) for a peg-in of the given amount.
   * @param {bigint} amount - The peg-in amount in satoshis.
   * @param {FeeLevel} feeLevel - The fee rate tier to use. Defaults to 'fast'.
   * @returns {Promise<number>} The estimated total fee in satoshis, based on a base transaction size and a fixed number of inputs.
   */
  async estimatePeginFee(amount: bigint, feeLevel: FeeLevel = 'fast') {
    const feeRate = await this.bitcoinDataSource.getFeeRate(feeLevel)
    const { baseFee, feePerInput } = await this.calculatePeginFee(amount, feeRate)
    const totalFee = baseFee + feePerInput * this.peginFeeEstimationInputs
    return totalFee
  }

  /**
   * Builds an unfunded PSBT for a peg-in: an RSKT-prefixed OP_RETURN output encoding the
   * recipient (and, if available, a refund address), plus an output paying the bridge's
   * federation address. Also stores the UTXOs and change address to be used by `fundPegin`.
   * @param {bigint} amount - The peg-in amount in satoshis to send to the federation address.
   * @param {string} recipientAddress - The Rootstock address that will receive the pegged-in funds.
   * @param {Utxo[]} selectedUtxos - UTXOs to use as inputs. If omitted, UTXOs are resolved from the configured bitcoin signer's used addresses.
   * @returns {Promise<Psbt>} The unfunded PSBT (without inputs) ready to be passed to `fundPegin`.
   */
  async createPegin(amount: bigint, recipientAddress: string, selectedUtxos?: Utxo[]) {
    const addresses = await this.getAddressesGroupedByUsage()
    const psbt = new Psbt({ network: this.btcNetworkConfig.lib })
    const refundAddress = addresses.nonChange.unused[0]?.address
    const { output: script } = payments.embed({ data: [this.getRskOutput(recipientAddress, refundAddress)] })
    if (script) {
      psbt.addOutput({
        script,
        value: 0,
      })
    }
    const bridgeAddress = await this.bridge.getFederationAddress()
    psbt.addOutput({
      address: bridgeAddress,
      value: Number(amount),
    })
    if (selectedUtxos) {
      this.utxos = selectedUtxos
    }
    else {
      const usedAddresses = addresses.nonChange.used.concat(addresses.change.used)
      const { withBalance } = this.groupAddressesByBalance(usedAddresses)
      this.utxos = await this.getUtxos(withBalance)
    }
    this.changeAddress = addresses.change.unused[0]?.address

    return psbt
  }

  private selectInputs(amount: bigint, utxos: Utxo[], baseFee: number, feePerInput: number) {
    const inputs: Utxo[] = []
    let remainingSatoshisToBePaid = BigInt(amount) + BigInt(baseFee)
    utxos.sort((a, b) => a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)
    utxos.forEach((utxo) => {
      if (remainingSatoshisToBePaid > 0) {
        inputs.push(utxo)
        remainingSatoshisToBePaid = remainingSatoshisToBePaid + BigInt(feePerInput) - BigInt(utxo.amount)
      }
    })
    return { inputs, rest: Number(remainingSatoshisToBePaid) }
  }

  private validatePeginAmount(amount: bigint) {
    if (amount < this.minPeginAmount) {
      throw new sdkErrors.AmountBelowMinError(`Minimum allowed amount is ${this.minPeginAmount} satoshis.`)
    }
  }

  private async calculatePeginFee(amount: bigint, feeRate: number) {
    this.validatePeginAmount(amount)
    const txSize = this.txHeaderSizeInBytes + this.txOutputSizeInBytes * this.pegInOutputs
    const baseFee = feeRate * txSize
    const feePerInput = feeRate * this.txInputSizeInBytes
    return { baseFee, feePerInput }
  }

  private async calculateFeeAndSelectedInputs(amount: bigint, utxos: Utxo[], feeRate: number) {
    const { baseFee, feePerInput } = await this.calculatePeginFee(amount, feeRate)
    const { inputs, rest } = this.selectInputs(amount, utxos, baseFee, feePerInput)
    if (rest > 0) {
      throw new sdkErrors.NotEnoughFundsError(`${rest} satoshis needed to cover the requested amount.`)
    }
    const totalFee = baseFee + feePerInput * inputs.length
    return { inputs, change: Math.abs(rest), totalFee }
  }

  /**
   * Funds a peg-in PSBT by selecting UTXOs to cover the amount plus fees, adding a change
   * output (unless it's below the dust threshold), and adding the corresponding inputs.
   * @param {Psbt} psbt - The PSBT to fund. Its second output's value is used as the amount if `value` isn't provided.
   * @param {FeeLevel} feeLevel - The fee rate tier to use. Defaults to 'fast'.
   * @param {bigint} value - The amount to fund, in satoshis. Defaults to the PSBT's second output value.
   * @returns {Promise<{psbt: Psbt, inputs: Utxo[], transactions: string[], fee: number}>} The funded PSBT, the selected inputs, their raw hex transactions, and the total fee in satoshis.
   */
  async fundPegin(psbt: Psbt, feeLevel: FeeLevel = 'fast', value?: bigint) {
    const amount = value ?? BigInt(psbt.txOutputs[1].value)
    const feeRate = await this.bitcoinDataSource.getFeeRate(feeLevel)
    const { inputs, change, totalFee } = await this.calculateFeeAndSelectedInputs(amount, this.utxos, feeRate)
    if (change > Math.min(this.burnDustValue, this.burnDustMaxValue)) {
      psbt.addOutput({
        address: this.changeAddress ?? inputs[0].address,
        value: change,
      })
    }
    const hexTransactions = await Promise.all(inputs.map((input) => this.bitcoinDataSource.getTxHex(input.txid)))
    inputs.forEach((input, index) => {
      const transaction = Transaction.fromHex(hexTransactions[index])
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        witnessUtxo: {
          script: transaction.outs[input.vout].script,
          value: transaction.outs[input.vout].value,
        },
      })
    })
    return { psbt, inputs, transactions: hexTransactions, fee: totalFee }
  }

  /**
   * Convenience method that sets the bitcoin signer, validates the amount, and runs
   * `createPegin` followed by `fundPegin` in sequence.
   * @param {bigint} amount - The peg-in amount in satoshis.
   * @param {string} recipientAddress - The Rootstock address that will receive the pegged-in funds.
   * @param {BitcoinSigner} signer - The bitcoin signer used to derive addresses and later sign the transaction.
   * @param {FeeLevel} feeLevel - The fee rate tier to use. Defaults to 'fast'.
   * @param {Utxo[]} selectedUtxos - UTXOs to use as inputs. If omitted, UTXOs are resolved from the signer's used addresses.
   * @returns {Promise<UnsignedPegin>} The funded, unsigned PSBT along with its inputs, raw transactions, and fee.
   */
  async createAndFundPegin(amount: bigint, recipientAddress: string, signer: BitcoinSigner, feeLevel: FeeLevel = 'fast', selectedUtxos?: Utxo[]): Promise<UnsignedPegin> {
    this.bitcoinSigner = signer
    this.validatePeginAmount(amount)
    const psbt = await this.createPegin(amount, recipientAddress, selectedUtxos)
    return this.fundPegin(psbt, feeLevel)
  }

  /**
   * Builds and funds a plain PSBT paying `amount` to `recipientAddress` using the given UTXOs.
   * Unlike `createAndFundPegin`, this does not add the PowPeg OP_RETURN output, so it is not
   * itself a peg-in transaction.
   * @param {bigint} amount - The amount in satoshis to send to `recipientAddress`.
   * @param {string} recipientAddress - The Bitcoin address to receive the funds.
   * @param {Utxo[]} utxos - The UTXOs to use as inputs.
   * @param {FeeLevel} feeLevel - The fee rate tier to use. Defaults to 'fast'.
   * @returns {Promise<UnsignedPegin>} The funded, unsigned PSBT along with its inputs, raw transactions, and fee.
   */
  async createAndFundPsbt(amount: bigint, recipientAddress: string, utxos: Utxo[], feeLevel: FeeLevel = 'fast'): Promise<UnsignedPegin> {
    const psbt = new Psbt({ network: this.btcNetworkConfig.lib })
    psbt.addOutput({
      address: recipientAddress,
      value: Number(amount),
    })
    this.utxos = utxos
    return this.fundPegin(psbt, feeLevel, amount)
  }

  private async signPegin(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string> {
    return this.bitcoinSigner.signTransaction(psbt, inputs, transactions)
  }

  /**
   * Signs a funded peg-in PSBT with the configured bitcoin signer and broadcasts it via the
   * configured bitcoin data source.
   * @param {Psbt} psbt - The funded PSBT to sign.
   * @param {Utxo[]} inputs - The UTXOs corresponding to the PSBT's inputs, as returned by `fundPegin`.
   * @param {string[]} transactions - The raw hex transactions corresponding to the inputs, as returned by `fundPegin`.
   * @returns {Promise<string>} The broadcasted transaction's id/hash.
   */
  async signAndBroadcastPegin(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string> {
    const signedTx = await this.signPegin(psbt, inputs, transactions)
    return this.bitcoinDataSource.broadcast(signedTx)
  }

  private validateMinimumPegoutAmount(amount: string): void {
    const amountBN = ethers.utils.parseUnits(amount, 18).toBigInt()
    const minAmountBN = ethers.utils.parseUnits(this.minPegoutAmount, 18).toBigInt()
    if (amountBN < minAmountBN) {
      throw new sdkErrors.AmountBelowMinError(`Minimum allowed amount is ${this.minPegoutAmount}.`)
    }
  }

  private createPegoutTransaction(amount: string, fromAddress: string) {
    const amountBN = ethers.utils.parseUnits(amount, 18).toBigInt()

    return {
      from: fromAddress,
      to: this.bridge.address,
      value: amountBN.toString(),
    }
  }

  /**
   * Estimates both the Rootstock gas fee and the Bitcoin network fee for a peg-out of the
   * given amount.
   * @param {string} amount - The peg-out amount, as a decimal string in RBTC (18 decimals).
   * @param {string} fromAddress - The Rootstock sender address used to estimate gas. Defaults to the zero address.
   * @returns {Promise<PegoutFeeEstimation>} The estimated bitcoin fee (satoshis) and rootstock fee (wei).
   */
  async estimatePegoutFees(amount: string, fromAddress: string = ethers.constants.AddressZero): Promise<PegoutFeeEstimation> {
    this.validateMinimumPegoutAmount(amount)
    const tx = this.createPegoutTransaction(amount, fromAddress)
    const [gas, gasPrice, bitcoinFee] = await Promise.all([
      this.rskProvider.estimateGas(tx),
      this.rskProvider.getGasPrice(),
      this.bridge.getPegoutEstimatedFee(),
    ])
    const rootstockFee = gas.mul(gasPrice).toBigInt()

    return {
      bitcoinFee,
      rootstockFee,
    }
  }

  /**
   * Builds a peg-out transaction request (a plain RSK transfer to the bridge address) after
   * validating the minimum amount and that the sender has sufficient balance.
   * @param {string} amount - The peg-out amount, as a decimal string in RBTC (18 decimals).
   * @param {string} senderAccount - The Rootstock address sending the funds.
   * @returns {Promise<{tx: {from: string, to: string, value: string}, rootstockFee: bigint, bitcoinFee: bigint}>} The unsigned transaction request along with the estimated rootstock and bitcoin fees.
   */
  async createPegout(amount: string, senderAccount: string) {
    const fees = await this.estimatePegoutFees(amount, senderAccount)
    const amountBN = ethers.utils.parseUnits(amount, 18).toBigInt()
    const balance = await this.rskProvider.getBalance(senderAccount)
    if (balance.lt(amountBN)) {
      throw new sdkErrors.NotEnoughFundsError(`Requested amount ${amountBN} is greater than current balance ${balance}.`)
    }
    const tx = this.createPegoutTransaction(amount, senderAccount)

    return {
      tx,
      rootstockFee: fees.rootstockFee,
      bitcoinFee: fees.bitcoinFee,
    }
  }

  /**
   * Sends a peg-out transaction with the given ethers signer and waits for it to be mined.
   * @param {{from: string, to: string, value: string}} tx - The transaction request, as returned by `createPegout`.
   * @param {ethers.Signer} signer - The ethers signer used to send the transaction.
   * @returns {Promise<ethers.providers.TransactionReceipt | undefined>} The transaction receipt once mined, or undefined if the signer has no provider.
   */
  async signAndBroadcastPegout(tx: { from: string, to: string, value: string }, signer: ethers.Signer) {
    const { hash } = await signer.sendTransaction(tx)

    return signer.provider?.waitForTransaction(hash)
  }

  /**
   * Fetches the current status of a peg-in or peg-out transaction from the configured API.
   * @param {string} txHash - The transaction hash to look up (an RSK tx hash for peg-outs, a BTC tx id for peg-ins).
   * @param {TxType} txType - Whether the transaction is a peg-in or a peg-out.
   * @returns {Promise<StatusData>} The transaction's status details.
   */
  async getTransactionStatus<T extends TxType>(txHash: string, txType: T) {
    return this.api.getTransactionStatus(txHash, txType)
  }

  /**
   * Fetches the available UTXOs for one or more Bitcoin addresses, deduplicated by txid:vout.
   * @param {string | string[]} addresses - One or more Bitcoin addresses to query, validated against the configured network.
   * @returns {Promise<Utxo[]>} The available UTXOs for the given addresses.
   * @throws {InvalidAddressError} If any of the addresses is not a valid address for the configured network.
   */
  async getAvailableUtxos(addresses: string | string[]): Promise<Utxo[]> {
    const addressList = Array.isArray(addresses) ? addresses : [addresses]
    const invalidAddresses = addressList.filter((address) => !this.btcNetworkConfig.isBtcAddress(address))
    if (invalidAddresses.length > 0) {
      throw new sdkErrors.InvalidAddressError(invalidAddresses)
    }
    return this.getUtxos(addressList)
  }
}
