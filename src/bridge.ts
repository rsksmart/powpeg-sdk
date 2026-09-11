import { bridge } from '@rsksmart/rsk-precompiled-abis'
import { ethers } from '@rsksmart/bridges-core-sdk'

export class Bridge {
  readonly address = bridge.address
  bridgeContract: ethers.Contract

  constructor(provider: ethers.providers.Provider) {
    this.bridgeContract = new ethers.Contract(bridge.address, bridge.abi, provider)
  }

  async getFederationAddress(): Promise<string> {
    return this.bridgeContract.getFederationAddress?.()
  }

  async getFeePerKb(): Promise<bigint> {
    const feePerKb: ethers.BigNumber = await this.bridgeContract.getFeePerKb()
    return feePerKb.toBigInt()
  }

  async getActivePowpegRedeemScript(): Promise<string> {
    return this.bridgeContract.getActivePowpegRedeemScript()
  }

  async getFederationThreshold(): Promise<number> {
    const threshold: ethers.BigNumber = await this.bridgeContract.getFederationThreshold()
    return threshold.toNumber()
  }

  /** Reads a `release_request_rejected` event out of a peg-out receipt's logs, if the Bridge emitted one. */
  findRejectedPegout(logs: { address: string, topics: string[], data: string }[]): { amount: bigint, reason: number } | undefined {
    for (const log of logs) {
      if (log.address?.toLowerCase() !== this.address.toLowerCase()) {
        continue
      }
      let parsed: ethers.utils.LogDescription
      try {
        parsed = this.bridgeContract.interface.parseLog(log)
      }
      catch {
        continue
      }
      if (parsed.name === 'release_request_rejected') {
        return { amount: parsed.args[1].toBigInt(), reason: parsed.args[2].toNumber() }
      }
    }
  }

  async getPegoutEstimatedFee(): Promise<bigint> {
    const [nextPegoutCost, pegoutQueueCount] = await Promise.all<[ethers.BigNumber, ethers.BigNumber]>([
      this.bridgeContract.getEstimatedFeesForNextPegOutEvent(),
      this.bridgeContract.getQueuedPegoutsCount(),
    ])
    return nextPegoutCost.div(pegoutQueueCount.add(1n)).toBigInt()
  }
}
