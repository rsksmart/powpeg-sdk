import { bridge } from '@rsksmart/rsk-precompiled-abis'
import { ethers } from '@rsksmart/bridges-core-sdk'
import type { Network } from './constants'

export class Bridge {
  address = '0x0000000000000000000000000000000001000006'
  provider: ethers.providers.Provider
  bridgeContract: ethers.Contract
  publicNodes: Record<Network, string> = {
    MAIN: 'https://public-node.rsk.co',
    TEST: 'https://public-node.testnet.rsk.co',
  }

  constructor(network: Network, rpcProviderUrl?: string) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcProviderUrl ?? this.publicNodes[network])
    this.bridgeContract = new ethers.Contract(bridge.address, bridge.abi, this.provider)
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
