import { bridge } from '@rsksmart/rsk-precompiled-abis'
import { ethers } from 'ethers'
import type { Network } from './types'

export class Bridge {
  provider: ethers.Provider
  bridgeContract: ethers.Contract
  publicNodes: Record<Network, string> = {
    mainnet: 'https://public-node.rsk.co',
    testnet: 'https://public-node.testnet.rsk.co',
  }

  constructor(network: Network, rpcProviderUrl?: string) {
    this.provider = new ethers.JsonRpcProvider(rpcProviderUrl ?? this.publicNodes[network])
    this.bridgeContract = new ethers.Contract(bridge.address, bridge.abi, this.provider)
  }

  async getFederationAddress(): Promise<string> {
    return this.bridgeContract.getFederationAddress?.()
  }
}
