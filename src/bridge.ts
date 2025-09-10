import { bridge } from '@rsksmart/rsk-precompiled-abis'
import { ethers } from '@rsksmart/bridges-core-sdk'

export class Bridge {
  readonly address = '0x0000000000000000000000000000000001000006'
  bridgeContract: ethers.Contract

  constructor(provider: ethers.providers.Provider) {
    this.bridgeContract = new ethers.Contract(bridge.address, bridge.abi, provider)
  }

  async getFederationAddress(): Promise<string> {
    return this.bridgeContract.getFederationAddress?.()
  }

  async getPegoutEstimatedFee(): Promise<bigint> {
    const [nextPegoutCost, pegoutQueueCount] = await Promise.all<[ethers.BigNumber, ethers.BigNumber]>([
      this.bridgeContract.getEstimatedFeesForNextPegOutEvent(),
      this.bridgeContract.getQueuedPegoutsCount(),
    ])
    return nextPegoutCost.div(pegoutQueueCount.add(1n)).toBigInt()
  }
}
