import { address, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import type { BitcoinDataSource, BitcoinSigner, Utxo, FeeLevel, AddressWithDetails, PegoutFeeEstimation, Feature, TxType, UnsignedPegin, UnsignedPegout, PowPegSDKOptions, RejectedPegoutReason } from '../types'
import { RejectedPegoutReasons } from '../types'
import { networks, type Network } from '../constants'
import { getAddressType, isP2shScript, isSupportedFundingScript, isWitnessProgramScript, remove0x } from '../utils'
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
  private funding = new WeakMap<Psbt, { utxos: Utxo[], changeAddress?: string, skippedSatoshis: bigint }>()
  private psbtSigner = new WeakMap<Psbt, BitcoinSigner>()
  private minPeginAmount = 500_000n
  private peginFeeEstimationInputs = 2
  private minPegoutSatoshis: Record<Network, bigint> = {
    MAIN: 400_000n,
    TEST: 250_000n,
  }
  private pegoutFeeGapPercentage = 80n
  private pegoutSimulationInputs = 2
  private pegoutSimulationOutputs = 2
  private pegoutScriptSigSize = 36
  private maxScriptSigRedeemScriptSize = 520
  private pegoutSignatureSize = 73
  private pegoutDeployedSignatureSize = 72
  private weiPerSatoshi = 10_000_000_000n
  private pegoutRejectionReasons: Record<RejectedPegoutReason, string> = {
    LOW_AMOUNT: 'the amount was below the minimum the Bridge enforces, and was refunded',
    CALLER_CONTRACT: 'peg-outs are only allowed from an externally owned account and the caller is a contract; the amount was NOT refunded and remains held by the Bridge',
    FEE_ABOVE_VALUE: 'the fee would have exceeded the amount being released, and the amount was refunded',
  }
  private btcNetworkConfig: typeof networks[Network]
  private bridge: Bridge
  private api: ApiService
  private rskProvider: ethers.providers.Provider
  private rskNetworks: Record<Network, { url: string, chainId: number }> = {
    MAIN: { url: 'https://public-node.rsk.co', chainId: 30 },
    TEST: { url: 'https://public-node.testnet.rsk.co', chainId: 31 },
  }
  private network: Network
  private _bitcoinSigner: BitcoinSigner | null
  private _bitcoinDataSource: BitcoinDataSource | null
  private maxBundleSize: number
  private burnDustValue: number
  private maxFeeRateSatPerByte: number
  private maxFeeToAmountRatio: number

  /**
   * @param {PowPegSDKOptions} options - SDK configuration. Only `network` is required; every other field
   * falls back to the default documented on {@link PowPegSDKOptions}.
   */
  constructor(options: PowPegSDKOptions) {
    assertTruthy(options, 'PowPegSDK takes a single options object; see PowPegSDKOptions.')
    assertTruthy(Object.prototype.hasOwnProperty.call(networks, options.network), `Unknown network ${String(options.network)}; use Network.MAIN or Network.TEST.`)
    const {
      network,
      bitcoinSigner = null,
      bitcoinDataSource = null,
      rpcProviderUrl,
      apiUrl,
      maxBundleSize = 10,
      burnDustValue = 2000,
      maxFeeRateSatPerByte = 1000,
      maxFeeToAmountRatio = 0.5,
      requestTimeoutMs = 10_000,
    } = options
    assertTruthy(Number.isInteger(maxBundleSize) && maxBundleSize > 0, `maxBundleSize must be a positive integer, got ${maxBundleSize}.`)
    assertTruthy(Number.isInteger(burnDustValue) && burnDustValue >= 0, `burnDustValue must be a non-negative integer, got ${burnDustValue}.`)
    assertTruthy(Number.isInteger(maxFeeRateSatPerByte) && maxFeeRateSatPerByte > 0, `maxFeeRateSatPerByte must be a positive integer, got ${maxFeeRateSatPerByte}.`)
    assertTruthy(Number.isFinite(maxFeeToAmountRatio) && maxFeeToAmountRatio > 0 && maxFeeToAmountRatio <= 1, `maxFeeToAmountRatio must be greater than 0 and at most 1, got ${maxFeeToAmountRatio}.`)
    this.network = network
    this._bitcoinSigner = bitcoinSigner
    this._bitcoinDataSource = bitcoinDataSource
    this.maxBundleSize = maxBundleSize
    this.burnDustValue = burnDustValue
    this.maxFeeRateSatPerByte = maxFeeRateSatPerByte
    this.maxFeeToAmountRatio = maxFeeToAmountRatio
    this.btcNetworkConfig = networks[network]
    this.rskProvider = new ethers.providers.JsonRpcProvider(rpcProviderUrl ?? this.rskNetworks[network].url, this.rskNetworks[network].chainId)
    this.bridge = new Bridge(this.rskProvider)
    this.api = new ApiService(network, apiUrl, maxFeeRateSatPerByte, requestTimeoutMs)
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
    const allUtxos = utxoLists.flatMap((utxos, i) => utxos.map((utxo) => ({ ...utxo, address: rawAddresses[i] })))

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
    return Promise.all(addresses.map(async (address) => ({
      ...await this.bitcoinDataSource.getAddressDetails(address),
      address,
    })))
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

  private isSpendableAddress(btcAddress: string) {
    try {
      return isSupportedFundingScript(address.toOutputScript(btcAddress, this.btcNetworkConfig.lib))
    }
    catch {
      return false
    }
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

  private async getAddressesGroupedByUsage(signer: BitcoinSigner) {
    const nonChangeAddresses = await signer.getNonChangeAddresses(this.maxBundleSize)
    const changeAddresses = await signer.getChangeAddresses(this.maxBundleSize)
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

  private async getVerifiedFederationAddress(): Promise<string> {
    const [bridgeAddress, peginConfiguration] = await Promise.all([
      this.bridge.getFederationAddress().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        throw new sdkErrors.FederationAddressError(`Could not retrieve the federation address from the Bridge contract: ${reason}`)
      }),
      this.api.getPeginConfiguration().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error)
        throw new sdkErrors.FederationAddressError(`Could not retrieve the pegin configuration: ${reason}`)
      }),
    ])
    if (peginConfiguration.federationAddress !== bridgeAddress) {
      throw new sdkErrors.FederationAddressError('Federation address mismatch between the Bridge contract and the pegin configuration.')
    }
    return bridgeAddress
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
    const feeRate = await this.getValidatedFeeRate(feeLevel)
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
   * @param {BitcoinSigner} [signer] - Signer to bind this PSBT to. Defaults to the signer configured in the constructor.
   * @returns {Promise<Psbt>} The unsigned, unfunded peg-in PSBT.
   */
  async createPegin(amount: bigint, recipientAddress: string, selectedUtxos?: Utxo[], signer: BitcoinSigner = this.bitcoinSigner) {
    const addresses = await this.getAddressesGroupedByUsage(signer)
    const psbt = new Psbt({ network: this.btcNetworkConfig.lib })
    const refundAddress = addresses.nonChange.unused[0]?.address
    const { output: script } = payments.embed({ data: [this.getRskOutput(recipientAddress, refundAddress)] })
    if (script) {
      psbt.addOutput({
        script,
        value: 0,
      })
    }
    const bridgeAddress = await this.getVerifiedFederationAddress()
    psbt.addOutput({
      address: bridgeAddress,
      value: Number(amount),
    })
    let utxos: Utxo[]
    let skippedSatoshis = 0n
    if (selectedUtxos) {
      utxos = [...selectedUtxos]
    }
    else {
      const usedAddresses = addresses.nonChange.used.concat(addresses.change.used)
      if (!usedAddresses.length && !addresses.nonChange.unused.length && !addresses.change.unused.length) {
        throw new sdkErrors.SigningError('The signer derived no addresses, so there is nothing to discover UTXOs from. Pass selectedUtxos to fund from a set you resolved yourself.')
      }
      const { withBalance } = this.groupAddressesByBalance(usedAddresses)
      const spendable = withBalance.filter((address) => this.isSpendableAddress(address.address))
      skippedSatoshis = withBalance
        .filter((address) => !this.isSpendableAddress(address.address))
        .reduce((total, address) => total + BigInt(address.balance), 0n)
      utxos = await this.getUtxos(spendable)
    }
    const changeAddress = addresses.change.unused.find((address) => this.isSpendableAddress(address.address))
      ?? addresses.change.unused[0]
    this.funding.set(psbt, { utxos, changeAddress: changeAddress?.address, skippedSatoshis })
    this.psbtSigner.set(psbt, signer)

    return psbt
  }

  private selectInputs(amount: bigint, utxos: Utxo[], baseFee: number, feePerInput: number) {
    const inputs: Utxo[] = []
    let remainingSatoshisToBePaid = BigInt(amount) + BigInt(baseFee)
    const candidates = [...utxos].sort((a, b) => Number(b.amount - a.amount))
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

  private validateFeeRate(feeRate: number): number {
    if (!Number.isInteger(feeRate) || feeRate <= 0 || feeRate > this.maxFeeRateSatPerByte) {
      throw new sdkErrors.InvalidFeeRateError(`Implausible fee rate: ${feeRate}`)
    }
    return feeRate
  }

  private async getValidatedFeeRate(feeLevel: FeeLevel): Promise<number> {
    const feeRate = await this.bitcoinDataSource.getFeeRate(feeLevel)
    return this.validateFeeRate(feeRate)
  }

  private async calculatePeginFee(amount: bigint, feeRate: number) {
    this.validatePeginAmount(amount)
    const txSize = this.txHeaderSizeInBytes + this.txOutputSizeInBytes * this.pegInOutputs
    const baseFee = feeRate * txSize
    const feePerInput = feeRate * this.txInputSizeInBytes
    return { baseFee, feePerInput }
  }

  private async calculateFeeAndSelectedInputs(amount: bigint, utxos: Utxo[], feeRate: number, skippedSatoshis = 0n) {
    const { baseFee, feePerInput } = await this.calculatePeginFee(amount, feeRate)
    const { inputs, rest } = this.selectInputs(amount, utxos, baseFee, feePerInput)
    if (rest > 0) {
      const skipped = skippedSatoshis > 0n
        ? ` A further ${skippedSatoshis} satoshis are held by addresses whose script type the SDK cannot build a signable input for; pass selectedUtxos to fund from a set you resolved yourself.`
        : ''
      throw new sdkErrors.NotEnoughFundsError(`${rest} satoshis needed to cover the requested amount.${skipped}`)
    }
    const totalFee = baseFee + feePerInput * inputs.length
    if (totalFee > Number(amount) * this.maxFeeToAmountRatio) {
      throw new sdkErrors.InvalidFeeRateError(`Fee ${totalFee} sat is disproportionate to the ${amount} sat being sent.`)
    }
    return { inputs, change: Math.abs(rest), totalFee }
  }

  /**
   * Adds funding inputs (and a change output, if above the dust threshold) to an existing peg-in PSBT,
   * using the UTXOs previously selected by {@link createPegin} or {@link createAndFundPsbt}.
   * @param {Psbt} psbt - The peg-in PSBT to fund.
   * @param {FeeLevel} feeLevel - Fee priority level used to look up the current network fee rate. Defaults to `'fast'`. Ignored if `feeRate` is provided.
   * @param {bigint} [value] - Amount being sent, in satoshis. Defaults to the PSBT's second output value.
   * @param {number} [feeRate] - Fee rate, in sat/B, to fund with. When omitted, a fresh rate is fetched from the configured `BitcoinDataSource` and validated. Pass a rate obtained independently to pin funding to that exact value instead of risking a second, possibly different, fetch.
   * @returns {Promise<UnsignedPegin>} The funded PSBT along with its inputs, their raw transactions, and the total fee.
   */
  async fundPegin(psbt: Psbt, feeLevel: FeeLevel = 'fast', value?: bigint, feeRate?: number) {
    const funding = this.funding.get(psbt)
    assertTruthy(funding, 'No funding context found for this PSBT. Create it with createPegin or createAndFundPsbt first.')
    const amount = value ?? BigInt(psbt.txOutputs[1].value)
    const resolvedFeeRate = feeRate !== undefined ? this.validateFeeRate(feeRate) : await this.getValidatedFeeRate(feeLevel)
    const { inputs, change, totalFee } = await this.calculateFeeAndSelectedInputs(amount, funding.utxos, resolvedFeeRate, funding.skippedSatoshis)
    // Fetch all external data before the first PSBT mutation
    const hexTransactions = await Promise.all(inputs.map((input) => this.bitcoinDataSource.getTxHex(input.txid)))
    const parsedOutputs = hexTransactions.map((hex, index) => {
      const tx = Transaction.fromHex(hex)
      assertTruthy(
        tx.getId() === inputs[index].txid,
        `Fetched transaction for UTXO ${inputs[index].txid}:${inputs[index].vout} does not match the requested txid (got ${tx.getId()}).`,
      )
      const output = tx.outs[inputs[index].vout]
      assertTruthy(output, `UTXO ${inputs[index].txid}:${inputs[index].vout} was not found in the fetched transaction.`)
      assertTruthy(
        BigInt(output.value) === inputs[index].amount,
        `UTXO ${inputs[index].txid}:${inputs[index].vout} value mismatch: fetched transaction reports ${output.value}, expected ${inputs[index].amount}.`,
      )
      return output
    })
    inputs.forEach((input, index) => {
      const script = parsedOutputs[index].script
      if (!isSupportedFundingScript(script)) {
        const detail = isP2shScript(script)
          ? `the P2SH address ${input.address}. Signing it needs a redeem script the SDK cannot derive, because BitcoinSigner exposes addresses but not the public keys behind them.`
          : `${input.address}, whose script type the SDK cannot build a signable input for.`
        throw new sdkErrors.UnsupportedAddressTypeError(
          input.address,
          `UTXO ${input.txid}:${input.vout} is held by ${detail} Fund the peg-in from a legacy (P2PKH) or native segwit (P2WPKH) address, or pass selectedUtxos that exclude this one.`,
        )
      }
    })
    const initialInputCount = psbt.txInputs.length
    const initialOutputCount = psbt.txOutputs.length
    const addChange = change > Math.min(this.burnDustValue, this.burnDustMaxValue)
    this.funding.delete(psbt)
    if (addChange) {
      psbt.addOutput({
        // Fall back to the first funding input's address when every derived
        // change address has already been used.
        address: funding.changeAddress ?? inputs[0].address,
        value: change,
      })
    }
    inputs.forEach((input, index) => {
      const output = parsedOutputs[index]
      psbt.addInput({
        hash: input.txid,
        index: input.vout,
        // A witness input is signed from witnessUtxo alone; a legacy input needs its parent transaction.
        ...(isWitnessProgramScript(output.script) ? {} : { nonWitnessUtxo: Buffer.from(hexTransactions[index], 'hex') }),
        witnessUtxo: {
          script: output.script,
          value: output.value,
        },
      })
    })
    const expectedInputCount = initialInputCount + inputs.length
    const expectedOutputCount = initialOutputCount + (addChange ? 1 : 0)
    assertTruthy(
      psbt.txInputs.length === expectedInputCount && psbt.txOutputs.length === expectedOutputCount,
      `Funded PSBT structure mismatch: expected ${expectedInputCount} inputs and ${expectedOutputCount} outputs, got ${psbt.txInputs.length} and ${psbt.txOutputs.length}.`,
    )
    return { psbt, inputs, transactions: hexTransactions, fee: totalFee }
  }

  /**
   * Convenience method that creates and funds a peg-in PSBT in one call.
   * @param {bigint} amount - Amount to peg in, in satoshis.
   * @param {string} recipientAddress - Rootstock address that will receive the pegged-in RBTC.
   * @param {BitcoinSigner} signer - Bitcoin signer used to derive the addresses funding this peg-in.
   * @param {FeeLevel} feeLevel - Fee priority level used to look up the current network fee rate. Defaults to `'fast'`.
   * @param {Utxo[]} [selectedUtxos] - UTXOs to fund the transaction with. If omitted, they're derived from the signer's used addresses.
   * @param {number} [feeRate] - Fee rate, in sat/B, to fund with. When omitted, a fresh rate is fetched from the configured `BitcoinDataSource` and validated. Pass a rate obtained independently to pin funding to that exact value instead of risking a second, possibly different, fetch.
   * @returns {Promise<UnsignedPegin>} The funded, unsigned peg-in PSBT along with its inputs, raw transactions, and total fee.
   */
  async createAndFundPegin(amount: bigint, recipientAddress: string, signer: BitcoinSigner, feeLevel: FeeLevel = 'fast', selectedUtxos?: Utxo[], feeRate?: number): Promise<UnsignedPegin> {
    this.validatePeginAmount(amount)
    const psbt = await this.createPegin(amount, recipientAddress, selectedUtxos, signer)
    return this.fundPegin(psbt, feeLevel, undefined, feeRate)
  }

  /**
   * Builds and funds a generic PSBT paying `amount` satoshis to `recipientAddress` using the given UTXOs,
   * without routing through the federation address (unlike {@link createPegin}).
   * @param {bigint} amount - Amount to send, in satoshis.
   * @param {string} recipientAddress - Bitcoin address to receive the payment.
   * @param {Utxo[]} utxos - UTXOs to fund the transaction with.
   * @param {FeeLevel} feeLevel - Fee priority level used to look up the current network fee rate. Defaults to `'fast'`.
   * @param {BitcoinSigner} [signer] - Signer to bind to the returned PSBT for {@link signAndBroadcastPegin}. Required to sign the result, since this method takes no signer otherwise.
   * @returns {Promise<UnsignedPegin>} The funded, unsigned PSBT along with its inputs, raw transactions, and total fee.
   */
  async createAndFundPsbt(amount: bigint, recipientAddress: string, utxos: Utxo[], feeLevel: FeeLevel = 'fast', signer?: BitcoinSigner): Promise<UnsignedPegin> {
    const psbt = new Psbt({ network: this.btcNetworkConfig.lib })
    psbt.addOutput({
      address: recipientAddress,
      value: Number(amount),
    })
    this.funding.set(psbt, { utxos: [...utxos], skippedSatoshis: 0n })
    if (signer) {
      this.psbtSigner.set(psbt, signer)
    }
    return this.fundPegin(psbt, feeLevel, amount)
  }

  private async signPegin(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string> {
    const signer = this.psbtSigner.get(psbt)
    assertTruthy(signer, 'No signer bound to this PSBT. Sign the PSBT returned by createPegin, createAndFundPegin, or createAndFundPsbt with a signer argument.')
    const signedTx = await signer.signTransaction(psbt, inputs, transactions)
    if (!signedTx) {
      throw new sdkErrors.SigningError('The signer returned no signed transaction.')
    }
    return signedTx
  }

  /**
   * Signs a peg-in PSBT with the configured Bitcoin signer and broadcasts it via the configured data source.
   * @param {Psbt} psbt - The funded peg-in PSBT to sign and broadcast.
   * @param {Utxo[]} [inputs] - The PSBT's funding UTXOs (the `inputs` field returned by `fundPegin`/`createAndFundPegin`), forwarded to the signer if it needs them. Required for signers that must verify each input against its funding transaction; optional only for signers that can sign directly from the PSBT.
   * @param {string[]} [transactions] - Raw hex transactions for `inputs` (the `transactions` field returned by `fundPegin`/`createAndFundPegin`), forwarded to the signer if it needs them. Required for signers that must verify each input against its funding transaction; optional only for signers that can sign directly from the PSBT.
   * @returns {Promise<string>} The broadcast transaction's ID.
   * @throws {SigningError} If the signer returns no signed transaction.
   */
  async signAndBroadcastPegin(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string> {
    const signedTx = await this.signPegin(psbt, inputs, transactions)
    return this.bitcoinDataSource.broadcast(signedTx)
  }

  private varIntSize(value: number): number {
    if (value < 0xfd) {
      return 1
    }
    if (value <= 0xffff) {
      return 3
    }
    if (value <= 0xffffffff) {
      return 5
    }
    return 9
  }

  /**
   * Witness bytes each input contributes once signed: the stack item count, the two empty elements the
   * federation's script pushes, one signature per required signer, and the redeem script itself.
   */
  private estimateSigningSizePerInput(redeemScriptSize: number, threshold: number): number {
    const stackItemCount = threshold + 3
    return this.varIntSize(stackItemCount)
      + 1
      + (this.varIntSize(this.pegoutSignatureSize) + this.pegoutSignatureSize) * threshold
      + 1
      + this.varIntSize(redeemScriptSize) + redeemScriptSize
  }

  /**
   * Resolves the federation's output script from its redeem script, and with it the transaction format
   * the Bridge builds. The address is required to derive from the redeem script: a P2SH wrapping the
   * witness program means P2SH-P2WSH, a P2SH wrapping the redeem script itself means a legacy multisig.
   */
  private resolveFederationOutput(redeemScript: Buffer, federationAddress: string): { outputScript: Buffer, isSegwit: boolean } {
    const network = this.btcNetworkConfig.lib
    const derivations: (() => { outputScript: Buffer, isSegwit: boolean } | undefined)[] = [
      () => {
        const segwit = payments.p2sh({ redeem: payments.p2wsh({ redeem: { output: redeemScript }, network }), network })
        return segwit.output && federationAddress === segwit.address ? { outputScript: segwit.output, isSegwit: true } : undefined
      },
      () => {
        if (redeemScript.length > this.maxScriptSigRedeemScriptSize) {
          return undefined
        }
        const legacy = payments.p2sh({ redeem: { output: redeemScript }, network })
        return legacy.output && federationAddress === legacy.address ? { outputScript: legacy.output, isSegwit: false } : undefined
      },
    ]
    let lastError: unknown
    for (const derive of derivations) {
      try {
        const candidate = derive()
        if (candidate) {
          return candidate
        }
      }
      catch (error) {
        lastError = error
      }
    }
    if (lastError) {
      throw new sdkErrors.FederationAddressError(`The active powpeg redeem script could not be interpreted: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    }
    throw new sdkErrors.FederationAddressError(`Federation address ${federationAddress} is not derivable from the active powpeg redeem script.`)
  }

  private buildPegoutSimulation(outputScript: Buffer, inputs: number, outputs: number, scriptSig?: Buffer): Transaction {
    const transaction = new Transaction()
    if (scriptSig) {
      for (let i = 0; i < inputs; i++) {
        transaction.addInput(Buffer.alloc(32), 0, undefined, scriptSig)
      }
    }
    for (let i = 0; i < outputs; i++) {
      transaction.addOutput(outputScript, 0)
    }
    return transaction
  }

  /**
   * Size the Bridge computes for a P2SH-P2WSH federation: the transaction is serialized without its
   * inputs and a fixed script-sig size is added per input instead.
   */
  private pegoutVSizeSegwit(redeemScript: Buffer, threshold: number, outputScript: Buffer, inputs: number, outputs: number): number {
    const baseSize = this.buildPegoutSimulation(outputScript, inputs, outputs).byteLength(false)
      + inputs * this.pegoutScriptSigSize
    const signingSize = threshold * inputs * this.pegoutDeployedSignatureSize
    const totalSize = baseSize + signingSize + inputs * redeemScript.length
    return Math.floor((totalSize + 3 * baseSize) / 4)
  }

  /**
   * Size the Bridge computes for a federation that is not P2SH-P2WSH: plain serialized bytes, with the
   * redeem script spent through each input's script sig and no witness discount.
   */
  private pegoutVSizeNonSegwit(redeemScript: Buffer, threshold: number, outputScript: Buffer, inputs: number, outputs: number): number {
    const baseSize = this.buildPegoutSimulation(outputScript, inputs, outputs, redeemScript).byteLength(false)
    return baseSize + threshold * inputs * this.pegoutDeployedSignatureSize
  }

  /**
   * Size the Bridge computes once RSKIP378 is active: every input is serialized, and its witness carries
   * one signature per required signer plus the redeem script, weighted as per BIP141.
   */
  private pegoutVSizeAfterRskip378(redeemScript: Buffer, threshold: number, outputScript: Buffer, inputs: number, outputs: number): number {
    const baseSize = this.buildPegoutSimulation(outputScript, inputs, outputs, Buffer.alloc(this.pegoutScriptSigSize)).byteLength(false)
    const witnessSize = inputs * this.estimateSigningSizePerInput(redeemScript.length, threshold)
    return Math.floor((4 * baseSize + witnessSize) / 4)
  }

  /**
   * Virtual size of the transaction the Bridge would build for a regular peg-out, taken as the larger of
   * what it computes today and what it will compute once RSKIP378 activates, so the derived minimum is
   * never below the one the Bridge enforces under either rule.
   */
  private simulatePegoutVSize(redeemScriptHex: string, threshold: number, federationAddress: string): number {
    const redeemScript = Buffer.from(remove0x(redeemScriptHex), 'hex')
    const { outputScript, isSegwit } = this.resolveFederationOutput(redeemScript, federationAddress)
    const inputs = this.pegoutSimulationInputs
    const outputs = this.pegoutSimulationOutputs
    const deployed = isSegwit
      ? this.pegoutVSizeSegwit(redeemScript, threshold, outputScript, inputs, outputs)
      : this.pegoutVSizeNonSegwit(redeemScript, threshold, outputScript, inputs, outputs)
    return Math.max(deployed, this.pegoutVSizeAfterRskip378(redeemScript, threshold, outputScript, inputs, outputs))
  }

  private async getMinimumPegoutSatoshis(): Promise<bigint> {
    const [feePerKb, redeemScript, threshold, federationAddress] = await Promise.all([
      this.bridge.getFeePerKb(),
      this.bridge.getActivePowpegRedeemScript(),
      this.bridge.getFederationThreshold(),
      this.bridge.getFederationAddress(),
    ])
    const pegoutSize = BigInt(this.simulatePegoutVSize(redeemScript, threshold, federationAddress))
    const feeForPegout = feePerKb * pegoutSize / 1000n
    const requiredFunds = feeForPegout + feeForPegout * this.pegoutFeeGapPercentage / 100n
    const networkMinimum = this.minPegoutSatoshis[this.network]
    return requiredFunds > networkMinimum ? requiredFunds : networkMinimum
  }

  private assertAtLeastMinimumPegout(amountSatoshis: bigint, minimumSatoshis: bigint): void {
    if (amountSatoshis < minimumSatoshis) {
      const minimumAmount = ethers.utils.formatUnits(minimumSatoshis * this.weiPerSatoshi, 18)
      throw new sdkErrors.AmountBelowMinError(`Minimum allowed amount is ${minimumAmount}.`)
    }
  }

  private async validateMinimumPegoutAmount(amount: string): Promise<void> {
    const amountSatoshis = ethers.utils.parseUnits(amount, 18).toBigInt() / this.weiPerSatoshi
    this.assertAtLeastMinimumPegout(amountSatoshis, this.minPegoutSatoshis[this.network])
    this.assertAtLeastMinimumPegout(amountSatoshis, await this.getMinimumPegoutSatoshis())
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
   * @throws {AmountBelowMinError} If `amount` is below the minimum the Bridge currently enforces, derived from its fee per kb and the active federation.
   */
  async estimatePegoutFees(amount: string, fromAddress: string = ethers.constants.AddressZero): Promise<PegoutFeeEstimation> {
    await this.validateMinimumPegoutAmount(amount)
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
   * @throws {UnsupportedSenderError} If `senderAccount` is a contract account.
   */
  async createPegout(amount: string, senderAccount: string) {
    const fees = await this.estimatePegoutFees(amount, senderAccount)
    const amountBN = ethers.utils.parseUnits(amount, 18).toBigInt()
    const [balance, senderCode] = await Promise.all([
      this.rskProvider.getBalance(senderAccount),
      this.rskProvider.getCode(senderAccount),
    ])
    if (senderCode !== '0x') {
      throw new sdkErrors.UnsupportedSenderError(`${senderAccount} is a contract account; the Bridge only releases BTC for peg-outs sent from an externally owned account.`)
    }
    if (balance.lt(amountBN)) {
      throw new sdkErrors.NotEnoughFundsError(`Requested amount ${amountBN} is greater than current balance ${balance}.`)
    }
    const tx = this.createPegoutTransaction(amount, senderAccount)

    return {
      tx: { ...tx, chainId: this.rskNetworks[this.network].chainId },
      rootstockFee: fees.rootstockFee,
      bitcoinFee: fees.bitcoinFee,
    }
  }

  /**
   * Sends a peg-out transaction (as returned by {@link createPegout}) using the given ethers signer
   * and waits for it to be mined.
   * @param {UnsignedPegout} tx - The peg-out transaction request, as returned by {@link createPegout}. Forwarded to the signer as given, so gas, nonce and fee fields set by the caller are honoured; only an absent chain id is filled in.
   * @param {ethers.Signer} signer - Ethers signer used to send the transaction.
   * @returns The mined transaction receipt, if the signer's provider is set.
   * @throws {WrongNetworkError} If the transaction's chain id, or the signer's chain, doesn't match the network the SDK was configured for.
   * @throws {TransactionRevertedError} If the transaction was mined but reverted.
   * @throws {PegoutRejectedError} If the transaction was mined but the Bridge rejected and refunded the release request.
   */
  async signAndBroadcastPegout(tx: UnsignedPegout, signer: ethers.Signer) {
    const expectedChainId = this.rskNetworks[this.network].chainId
    const request = { ...tx, chainId: tx.chainId === undefined ? expectedChainId : tx.chainId }
    assertTruthy(
      typeof request.to === 'string' && request.to.toLowerCase() === this.bridge.address.toLowerCase(),
      `A peg-out is a value transfer to the bridge at ${this.bridge.address}; this request is addressed to ${String(request.to)}.`,
    )
    assertTruthy(
      request.data === undefined || request.data === '0x',
      'A peg-out carries no calldata; remove the data field from the request.',
    )
    if (request.chainId !== expectedChainId) {
      throw new sdkErrors.WrongNetworkError(`The transaction targets chain ${request.chainId}, but the SDK is configured for ${this.network} (chain ${expectedChainId}).`)
    }
    const signerChainId = await signer.getChainId()
    if (signerChainId !== expectedChainId) {
      throw new sdkErrors.WrongNetworkError(`Signer is on chain ${signerChainId}, but the SDK is configured for ${this.network} (chain ${expectedChainId}).`)
    }
    const { hash } = await signer.sendTransaction(request)
    const receipt = await signer.provider?.waitForTransaction(hash)
    if (receipt) {
      if (receipt.status === 0) {
        throw new sdkErrors.TransactionRevertedError(hash, receipt, `The peg-out transaction ${hash} was mined but reverted; no BTC release was requested.`)
      }
      const rejected = this.bridge.findRejectedPegout(receipt.logs ?? [])
      if (rejected) {
        const reason = this.pegoutRejectionReasons[RejectedPegoutReasons[rejected.reason as keyof typeof RejectedPegoutReasons]] ?? `the Bridge reported reason code ${rejected.reason}`
        throw new sdkErrors.PegoutRejectedError(
          rejected.reason,
          hash,
          rejected.amount,
          `The Bridge rejected the peg-out of ${rejected.amount} wei in transaction ${hash}: ${reason}.`,
        )
      }
    }

    return receipt
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
