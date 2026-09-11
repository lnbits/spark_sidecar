// Test-only wallet. This loader never connects to Spark or handles real funds.
import {readFileSync} from 'node:fs'
import {EventEmitter} from 'node:events'
const state = () =>
  JSON.parse(readFileSync(process.env.SPARK_TEST_STATE, 'utf8'))
export const SparkWalletEvent = {TransferClaimed: 'claimed'}
const invoice = data => ({
  id: 'receive-test',
  typename: 'LightningReceiveRequest',
  updatedAt: data.updatedAt,
  status: 'LIGHTNING_PAYMENT_RECEIVED',
  invoice: {paymentHash: 'a'.repeat(64)},
  transfer: {sparkId: 'transfer-test'},
  paymentPreimage: 'test-preimage'
})
export const SparkWallet = {
  initialize: async () => {
    const wallet = new EventEmitter()
    wallet.leafManager = {leaves: new Map()}
    wallet.setPrivacyEnabled = async () => {}
    wallet.getLightningReceiveRequest = async id => {
      const data = state()
      if (data.outage) throw new Error('mock outage')
      return id === 'receive-test' ? invoice(data) : null
    }
    wallet.getUserRequests = async () => ({
      entities: [invoice(state())],
      pageInfo: {hasNextPage: false}
    })
    wallet.getTransferFromSsp = async () => ({userRequest: invoice(state())})
    wallet.getTransfer = async () => ({
      id: 'transfer-test',
      receiverIdentityPublicKey: `02${'1'.repeat(64)}`,
      transferDirection: 'INCOMING',
      status: 'TRANSFER_STATUS_COMPLETED',
      leaves: [
        {
          leaf: {
            id: 'leaf-test',
            status: state().operatorStatus,
            ownerIdentityPublicKey: state().optimized
              ? `03${'2'.repeat(64)}`
              : `02${'1'.repeat(64)}`
          }
        }
      ]
    })
    wallet.getBalance = async () => {
      if (state().balanceError) {
        const error = new Error(
          `Fixture SDK error: ${process.env.SPARK_MNEMONIC}`
        )
        error.context = {mnemonic: process.env.SPARK_MNEMONIC}
        throw error
      }
      wallet.leafManager.leaves.clear()
      wallet.leafManager.leaves.set(
        state().optimized ? 'replacement' : 'leaf-test',
        {
          status: state().localStatus
        }
      )
      return {balance: 1000000n}
    }
    let event = 0
    const timer = setInterval(() => {
      const next = state().event || 0
      if (next !== event) {
        event = next
        wallet.emit('claimed', 'transfer-test')
      }
    }, 20)
    wallet.cleanupConnections = async () => clearInterval(timer)
    return {wallet}
  }
}
