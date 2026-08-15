import { address, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import type { BitcoinDataSource, BitcoinSigner, Utxo, FeeLevel, AddressWithDetails, PegoutFeeEstimation, Feature, TxType, UnsignedPegin } from '../types'
import { networks, type Network } from '../constants'
import { getAddressType, remove0x } from '../utils'
import { Bridge } from '../bridge'
import { ApiService } from '../api/api'
import * as sdkErrors from '../errors'
import { assertTruthy, ethers } from '@rsksmart/bridges-core-sdk'

/**
 * SDK for creating, funding, signing and broadcasting native PowPeg peg-in (BTC -> RBTC)
 * and peg-out (RBTC -> BTC) transactions.
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

  private validateRskRecipient(recipientAddress: string): string {
    // Rootstock uses EIP-1191 (RSKIP-60) checksums, so EIP-55 validators
    // such as ethers.utils.isAddress reject valid Rootstock addresses.
    const trimmed = recipientAddress.trim()
    if (!/^(0x)?[0-9a-fA-F]{40}$/.test(trimmed)) {
      throw new sdkErrors.InvalidAddressError([recipientAddress], `Invalid Rootstock recipient: ${recipientAddress}`)
    }
    return trimmed.toLowerCase()
  }

  private getRskOutput(recipientAddress: string, refundAddress?: string) {
    let output = `${this.powpegRsktHeader}${remove0x(this.validateRskRecipient(recipientAddress))}`
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
   * Estimates the Bitcoin network fee (in satoshis) to pay for a peg-in transaction of the given amount.
   * @param {bigint} amount - Amount to peg in, in satoshis.
   * @param {FeeLevel} feeLevel - Fee priority level used to look up the current network fee rate. Defaults to `'fast'`.
   * @param {Utxo[]} [utxos] - UTXOs available to fund the peg-in. When provided, the estimate runs the
   * same input selection used to fund the transaction; otherwise it assumes a fixed number of inputs.
   * @returns {Promise<number>} The estimated total fee in satoshis.
   */
  async estimatePeginFee(amount: bigint, feeLevel: FeeLevel = 'fast', utxos?: Utxo[]) {
    const feeRate = await this.bitcoinDataSource.getFeeRate(feeLevel)
    if (utxos) {
      const { totalFee } = await this.calculateFeeAndSelectedInputs(amount, utxos, feeRate)
      return totalFee
    }
    const { baseFee, feePerInput } = await this.calculatePeginFee(amount, feeRate)
    const totalFee = baseFee + feePerInput * this.peginFeeEstimationInputs
    return totalFee
  }

  /**
   * Builds an unsigned peg-in PSBT that sends `amount` satoshis to the federation's Bitcoin address,
   * encoding `recipientAddress` (and an unused refund address, if available) in an OP_RETURN output.
   * Also records the UTXOs and change address {@link fundPegin} will use to fund the transaction.
   * @param {bigint} amount - Amount to peg in, in satoshis.
   * @param {string} recipientAddress - Rootstock address that will receive the pegged-in RBTC.
   * @param {Utxo[]} [selectedUtxos] - UTXOs to fund the transaction with. If omitted, they're derived from the signer's used addresses.
   * @returns {Promise<Psbt>} The unsigned, unfunded peg-in PSBT.
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
    const candidates = [...utxos].sort((a, b) => a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0)
    for (const utxo of candidates) {
      if (remainingSatoshisToBePaid <= 0) {
        break
      }
      if (BigInt(utxo.amount) <= BigInt(feePerInput)) {
        continue
      }
      inputs.push(utxo)
      remainingSatoshisToBePaid = remainingSatoshisToBePaid + BigInt(feePerInput) - BigInt(utxo.amount)
    }
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
   * Adds funding inputs (and a change output, if above the dust threshold) to an existing peg-in PSBT,
   * using the UTXOs previously selected by {@link createPegin} or {@link createAndFundPsbt}.
   * @param {Psbt} psbt - The peg-in PSBT to fund.
   * @param {FeeLevel} feeLevel - Fee priority level used to look up the current network fee rate. Defaults to `'fast'`.
   * @param {bigint} [value] - Amount being sent, in satoshis. Defaults to the PSBT's second output value.
   * @returns {Promise<UnsignedPegin>} The funded PSBT along with its inputs, their raw transactions, and the total fee.
   */
  async fundPegin(psbt: Psbt, feeLevel: FeeLevel = 'fast', value?: bigint) {
    const amount = value ?? BigInt(psbt.txOutputs[1].value)
    const feeRate = await this.bitcoinDataSource.getFeeRate(feeLevel)
    const { inputs, change, totalFee } = await this.calculateFeeAndSelectedInputs(amount, this.utxos, feeRate)
    if (change > Math.min(this.burnDustValue, this.burnDustMaxValue)) {
      psbt.addOutput({
        // Fall back to the first funding input's address when every derived
        // change address has already been used.
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
   * Convenience method that creates and funds a peg-in PSBT in one call.
   * @param {bigint} amount - Amount to peg in, in satoshis.
   * @param {string} recipientAddress - Rootstock address that will receive the pegged-in RBTC.
   * @param {BitcoinSigner} signer - Bitcoin signer used to derive the addresses funding this peg-in.
   * @param {FeeLevel} feeLevel - Fee priority level used to look up the current network fee rate. Defaults to `'fast'`.
   * @param {Utxo[]} [selectedUtxos] - UTXOs to fund the transaction with. If omitted, they're derived from the signer's used addresses.
   * @returns {Promise<UnsignedPegin>} The funded, unsigned peg-in PSBT along with its inputs, raw transactions, and total fee.
   */
  async createAndFundPegin(amount: bigint, recipientAddress: string, signer: BitcoinSigner, feeLevel: FeeLevel = 'fast', selectedUtxos?: Utxo[]): Promise<UnsignedPegin> {
    this.bitcoinSigner = signer
    this.validatePeginAmount(amount)
    const psbt = await this.createPegin(amount, recipientAddress, selectedUtxos)
    return this.fundPegin(psbt, feeLevel)
  }

  /**
   * Builds and funds a generic PSBT paying `amount` satoshis to `recipientAddress` using the given UTXOs,
   * without routing through the federation address (unlike {@link createPegin}).
   * @param {bigint} amount - Amount to send, in satoshis.
   * @param {string} recipientAddress - Bitcoin address to receive the payment.
   * @param {Utxo[]} utxos - UTXOs to fund the transaction with.
   * @param {FeeLevel} feeLevel - Fee priority level used to look up the current network fee rate. Defaults to `'fast'`.
   * @returns {Promise<UnsignedPegin>} The funded, unsigned PSBT along with its inputs, raw transactions, and total fee.
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
   * Signs a peg-in PSBT with the configured Bitcoin signer and broadcasts it via the configured data source.
   * @param {Psbt} psbt - The funded peg-in PSBT to sign and broadcast.
   * @param {Utxo[]} [inputs] - The PSBT's funding UTXOs (the `inputs` field returned by `fundPegin`/`createAndFundPegin`), forwarded to the signer if it needs them. Required for the bundled hardware-wallet signers (Ledger, Trezor); optional only for signers that can sign directly from the PSBT.
   * @param {string[]} [transactions] - Raw hex transactions for `inputs` (the `transactions` field returned by `fundPegin`/`createAndFundPegin`), forwarded to the signer if it needs them. Required for the bundled hardware-wallet signers (Ledger, Trezor); optional only for signers that can sign directly from the PSBT.
   * @returns {Promise<string>} The broadcast transaction's ID.
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
   * Estimates the Bitcoin and Rootstock fees for a peg-out of the given RBTC amount.
   * @param {string} amount - Amount to peg out, in RBTC (18 decimals).
   * @param {string} [fromAddress] - Rootstock sender address used to estimate gas. Defaults to the zero address.
   * @returns {Promise<PegoutFeeEstimation>} The estimated Bitcoin fee (satoshis) and Rootstock gas fee (wei).
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
   * Validates the requested amount and the sender's balance, then builds an unsigned peg-out
   * transaction (a value-transfer call to the bridge precompile) together with its estimated fees.
   * @param {string} amount - Amount to peg out, in RBTC (18 decimals).
   * @param {string} senderAccount - Rootstock address that will send the peg-out.
   * @returns The unsigned transaction request and its estimated Bitcoin/Rootstock fees.
   * @throws {NotEnoughFundsError} If `senderAccount`'s balance is lower than `amount`.
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
   * Sends a peg-out transaction (as returned by {@link createPegout}) using the given ethers signer
   * and waits for it to be mined.
   * @param {{ from: string, to: string, value: string }} tx - The peg-out transaction request.
   * @param {ethers.Signer} signer - Ethers signer used to send the transaction.
   * @returns The mined transaction receipt, if the signer's provider is set.
   */
  async signAndBroadcastPegout(tx: { from: string, to: string, value: string }, signer: ethers.Signer) {
    const { hash } = await signer.sendTransaction(tx)

    return signer.provider?.waitForTransaction(hash)
  }

  /**
   * Fetches the current status of a peg-in or peg-out transaction from the configured API.
   * @param {string} txHash - The Bitcoin or Rootstock transaction hash to look up.
   * @param {T} txType - Whether `txHash` is a peg-in or a peg-out transaction.
   * @returns {Promise<Extract<StatusData, { type: T }>>} The transaction's type-narrowed status details.
   */
  async getTransactionStatus<T extends TxType>(txHash: string, txType: T) {
    return this.api.getTransactionStatus(txHash, txType)
  }

  /**
   * Retrieves the feature flags from the 2WP API `/features` endpoint.
   * @returns {Promise<Feature[]>} The feature flags as returned by the API.
   */
  async getFeatures(): Promise<Feature[]> {
    return this.api.getFeatures()
  }

  /**
   * Returns the spendable UTXOs for the given Bitcoin address(es).
   * @param {string | string[]} addresses - One or more Bitcoin addresses to fetch UTXOs for.
   * @returns {Promise<Utxo[]>} The UTXOs available across the given address(es).
   * @throws {InvalidAddressError} If any address doesn't belong to the SDK's configured network.
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
