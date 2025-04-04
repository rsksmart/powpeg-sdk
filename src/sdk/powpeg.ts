import { address, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import type { BitcoinDataSource, BitcoinSigner, Utxo, FeeLevel, AddressWithDetails } from '../types'
import { networks, type Network } from '../constants'
import { getAddressType, remove0x } from '../utils'
import { Bridge } from '../bridge'
import * as sdkErrors from '../errors'
import { ethers } from '@rsksmart/bridges-core-sdk'

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
  private minPegoutAmount = '0.004'
  private bitcoinJsNetwork
  private bridge: Bridge

  /**
   * @param {BitcoinSigner} bitcoinSigner - An instance of a class that implements the BitcoinSigner interface.
   * @param {BitcoinDataSource} bitcoinDataSource - An instance of a class that implements the BitcoinDataSource interface.
   * @param {Network} network - The network to use. Either 'MAIN' or 'TEST'.
   * @param {string} rpcProviderUrl - URL of either your own Rootstock node, the Rootstock RPC API or a third-party node provider. If not provided, it will default to the Rootstock public node for the specified network.
   * @param {number} maxBundleSize - The maximum number of addresses to ask for while creating a peg-in transaction. Defaults to 10.
   */
  constructor(
    private bitcoinSigner: BitcoinSigner,
    private bitcoinDataSource: BitcoinDataSource,
    private network: Network,
    rpcProviderUrl?: string,
    private maxBundleSize = 10,
    private burnDustValue = 2000,
  ) {
    this.bitcoinJsNetwork = networks[network].lib
    this.bridge = new Bridge(network, rpcProviderUrl)
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

  private async calculateFeeAndSelectedInputs(amount: bigint, utxos: Utxo[], feeRate: number) {
    if (amount < this.minPeginAmount) {
      throw new sdkErrors.AmountBelowMinError(`Minimum allowed amount is ${this.minPeginAmount} satoshis.`)
    }
    const txSize = this.txHeaderSizeInBytes + this.txOutputSizeInBytes * this.pegInOutputs
    const baseFee = feeRate * txSize
    const feePerInput = feeRate * this.txInputSizeInBytes
    const { inputs, rest } = this.selectInputs(amount, utxos, baseFee, feePerInput)
    if (rest > 0) {
      throw new sdkErrors.NotEnoughFundsError(`${rest} satoshis needed to cover the requested amount.`)
    }
    return { inputs, change: Math.abs(rest) }
  }

  async fundPegin(psbt: Psbt, feeLevel: FeeLevel) {
    const amount = BigInt(psbt.txOutputs[1].value)
    const feeRate = await this.bitcoinDataSource.getFeeRate(feeLevel)
    const { inputs, change } = await this.calculateFeeAndSelectedInputs(amount, this.utxos, feeRate)
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
    return { psbt, inputs, transactions: hexTransactions }
  }

  private async signPegin(psbt: Psbt, inputs?: Utxo[], transactions?: string[]): Promise<string> {
    return this.bitcoinSigner.signTransaction(psbt, inputs, transactions)
  }

  async signAndBroadcastPegin(psbt: Psbt, inputs?: Utxo[]): Promise<string> {
    const signedTx = await this.signPegin(psbt, inputs)
    return this.bitcoinDataSource.broadcast(signedTx)
  }

  async createPegout(amount: string, senderAccount: string, provider: ethers.providers.Provider) {
    const amountBN = ethers.utils.parseUnits(amount, 18).toBigInt()
    const minAmountBN = ethers.utils.parseUnits(this.minPegoutAmount, 18).toBigInt()
    if (amountBN < minAmountBN) {
      throw new sdkErrors.AmountBelowMinError(`Minimum allowed amount is ${this.minPegoutAmount}.`)
    }
    const balance = await provider.getBalance(senderAccount)
    if (balance.lt(amountBN)) {
      throw new sdkErrors.NotEnoughFundsError(`Requested amount ${amountBN} is greater than current balance ${balance}.`)
    }
    const tx = {
      from: senderAccount,
      to: this.bridge.address,
      value: amountBN.toString(),
    }
    const gas = await provider.estimateGas(tx)
    const gasPrice = await provider.getGasPrice()
    const rootstockFee = gas.mul(gasPrice).toBigInt()
    const bitcoinFee = await this.bridge.getPegoutEstimatedFee()

    return { tx, rootstockFee, bitcoinFee }
  }

  async signAndBroadcastPegout(tx: { from: string, to: string, value: string }, signer: ethers.Signer) {
    const { hash } = await signer.sendTransaction(tx)

    return signer.provider?.waitForTransaction(hash)
  }
}
