import { address, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import type { BitcoinDataSource, BitcoinSigner, Utxo, FeeLevel, AddressWithDetails, PegoutFeeEstimation, TxType, UnsignedPegin } from '../types'
import { networks, type Network } from '../constants'
import { getAddressType, remove0x } from '../utils'
import { Bridge } from '../bridge'
import { ApiService } from '../api/api'
import * as sdkErrors from '../errors'
import { assertTruthy, ethers } from '@rsksmart/bridges-core-sdk'

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
  private bitcoinJsNetwork
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
    this.bitcoinJsNetwork = networks[network].lib
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

  private async getUtxos(addresses: AddressWithDetails[]) {
    return Promise.all(addresses.map(({ address }) => this.bitcoinDataSource.getOutputs(address)))
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

  private async initPegin() {
    const nonChangeAddresses = await this.bitcoinSigner.getNonChangeAddresses(this.maxBundleSize)
    const changeAddresses = await this.bitcoinSigner.getChangeAddresses(this.maxBundleSize)
    const [nonChangeAddressesWithDetails, changeAddressesWithDetails] = await Promise.all([
      this.getAddressesWithDetails(nonChangeAddresses),
      this.getAddressesWithDetails(changeAddresses),
    ])
    const { used: usedNonChangeAddresses, unused: unusedNonChangeAddress } = this.groupAddressesByUsage(nonChangeAddressesWithDetails)
    const { used: usedChangeAddresses, unused: unusedChangeAddresses } = this.groupAddressesByUsage(changeAddressesWithDetails)
    const addresses = usedNonChangeAddresses.concat(usedChangeAddresses)
    const { withBalance: addressesWithBalance } = this.groupAddressesByBalance(addresses)
    const refundAddress = unusedNonChangeAddress[0]
    const changeAddress = unusedChangeAddresses[0]
    return { addressesWithBalance, refundAddress, changeAddress }
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

  async estimatePeginFee(amount: bigint, feeLevel: FeeLevel = 'fast') {
    const feeRate = await this.bitcoinDataSource.getFeeRate(feeLevel)
    const { baseFee, feePerInput } = await this.calculatePeginFee(amount, feeRate)
    const totalFee = baseFee + feePerInput * this.peginFeeEstimationInputs
    return totalFee
  }

  async createPegin(amount: bigint, recipientAddress: string) {
    const { addressesWithBalance, refundAddress, changeAddress } = await this.initPegin()
    const psbt = new Psbt({ network: this.bitcoinJsNetwork })
    const { output: script } = payments.embed({ data: [this.getRskOutput(recipientAddress, refundAddress?.address)] })
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
    this.utxos = (await this.getUtxos(addressesWithBalance)).flat()
    this.changeAddress = changeAddress?.address
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

  async fundPegin(psbt: Psbt, feeLevel: FeeLevel = 'fast') {
    const amount = BigInt(psbt.txOutputs[1].value)
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

  async createAndFundPegin(amount: bigint, recipientAddress: string, signer: BitcoinSigner, feeLevel: FeeLevel = 'fast'): Promise<UnsignedPegin> {
    this.bitcoinSigner = signer
    this.validatePeginAmount(amount)
    const psbt = await this.createPegin(amount, recipientAddress)
    return this.fundPegin(psbt, feeLevel)
  }

  private async signPegin(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string> {
    return this.bitcoinSigner.signTransaction(psbt, inputs, transactions)
  }

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

  async signAndBroadcastPegout(tx: { from: string, to: string, value: string }, signer: ethers.Signer) {
    const { hash } = await signer.sendTransaction(tx)

    return signer.provider?.waitForTransaction(hash)
  }

  async getTransactionStatus<T extends TxType>(txHash: string, txType: T) {
    return this.api.getTransactionStatus(txHash, txType)
  }
}
