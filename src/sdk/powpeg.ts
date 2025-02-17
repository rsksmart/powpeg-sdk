import { address, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib'
import type { BitcoinDataSource, BitcoinSigner, Network, Utxo, FeeLevel, AddressWithDetails } from '../types'
import { getAddressType, remove0x } from '../utils'
import { Bridge } from '../bridge'
import * as sdkErrors from '../errors'

export class PowPegSDK {
  private maxBundleSize = 10
  private txHeaderSizeInBytes = 13
  private txOutputSizeInBytes = 32
  private txInputSizeInBytes = 145
  private pegInOutputs = 3
  private powpegRsktHeader = '52534b5401'
  private burnDustMaxValue = 30_000
  private utxos: Utxo[] = []
  private changeAddress?: string
  private minPeginAmount = 500_000n
  private bitcoinJsNetwork: networks.Network
  private bridge: Bridge

  /**
   * @param {BitcoinSigner} bitcoinSigner - An instance of a class that implements the BitcoinSigner interface.
   * @param {BitcoinDataSource} bitcoinDataSource - An instance of a class that implements the BitcoinDataSource interface.
   * @param {Network} network - The network to use. Either 'mainnet' or 'testnet'.
   * @param {string} rpcProviderUrl - URL of either your own Rootstock node, the Rootstock RPC API or a third-party node provider. If not provided, it will default to the Rootstock public node for the specified network.
   */
  constructor(
    private bitcoinSigner: BitcoinSigner,
    private bitcoinDataSource: BitcoinDataSource,
    private network: Network,
    rpcProviderUrl?: string,
  ) {
    this.bitcoinJsNetwork = network === 'mainnet' ? networks.bitcoin : networks.testnet
    this.bridge = new Bridge(network, rpcProviderUrl)
  }

  private async getUtxos(addresses: AddressWithDetails[]) {
    return Promise.all(addresses.map(({ address }) => this.bitcoinDataSource.getOutputs(address)))
  }

  private async getAddressesWithDetails(addresses: string[]) {
    return Promise.all(addresses.map(address => this.bitcoinDataSource.getAddressDetails(address)))
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
    const [nonChangeAddresses, changeAddresses] = await Promise.all([
      this.bitcoinSigner.getNonChangeAddresses(this.maxBundleSize),
      this.bitcoinSigner.getChangeAddresses(this.maxBundleSize),
    ])
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
    let output = `${this.powpegRsktHeader + remove0x(recipientAddress)}`
    if (refundAddress) {
      const refundAddressType = getAddressType(refundAddress, this.network)
      const hash = address.fromBase58Check(refundAddress).hash.toString('hex')
      switch (refundAddressType) {
        case 'LEGACY':
          output += `01${hash}`
          break
        case 'SEGWIT':
          output += `02${hash}`
          break
        default:
          break
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
    if (change > this.burnDustMaxValue) {
      psbt.addOutput({
        address: this.changeAddress ?? inputs[0].address,
        value: change,
      })
    }
    const hexTransactions = await Promise.all(inputs.map(input => this.bitcoinDataSource.getTxHex(input.txid)))
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
    return psbt
  }

  private async signPegin(psbt: Psbt): Promise<string> {
    return this.bitcoinSigner.signTransaction(psbt)
  }

  async signAndBroadcastPegin(psbt: Psbt): Promise<string> {
    const signedTx = await this.signPegin(psbt)
    return this.bitcoinDataSource.broadcast(signedTx)
  }
}
