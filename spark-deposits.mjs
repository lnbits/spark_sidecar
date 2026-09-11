import {
  getP2TRAddressFromPkScript,
  getTxFromRawTxHex,
  getTxId,
  KeyDerivationType,
  NetworkToProto
} from '@buildonspark/spark-sdk'
import {mapTreeNodeToWalletLeaf} from '@buildonspark/spark-sdk/types'

// SDK 0.9.0's public claimDeposit picks the first unused address in a tx.
// Keep its internal, output-specific operations isolated here and pin the SDK.
async function depositTransaction(wallet, address, data) {
  const tx = await wallet.getDepositTransaction(data.txid)
  const output = tx.getOutput(data.vout)
  if (
    getTxId(tx) !== data.txid ||
    Number(output?.amount) !== data.amount_sats ||
    getP2TRAddressFromPkScript(output.script, wallet.config.getNetwork()) !==
      address
  )
    throw new Error('Deposit transaction does not match the requested output')
  return tx
}

export const sparkDeposits = {
  async prepare(wallet, address, data) {
    const tx = await depositTransaction(wallet, address, data)
    const addresses = await wallet.queryAllUnusedDepositAddresses({
      identityPublicKey: await wallet.config.signer.getIdentityPublicKey(),
      network: NetworkToProto[wallet.config.getNetwork()]
    })
    const deposit = addresses.find(item => item.depositAddress === address)
    if (!deposit)
      throw new Error('Deposit address is already claimed; reconcile it')
    return {
      txHex: Buffer.from(tx.toBytes(true)).toString('hex'),
      vout: data.vout,
      verifyingKey: Buffer.from(deposit.verifyingPublicKey).toString('hex'),
      keyDerivation: deposit.leafId
        ? {type: KeyDerivationType.LEAF, path: deposit.leafId}
        : {type: KeyDerivationType.DEPOSIT}
    }
  },

  async claim(wallet, prepared) {
    const tx = getTxFromRawTxHex(prepared.txHex)
    const nodes = await wallet.finalizeDeposit({
      depositTx: tx,
      vout: prepared.vout,
      verifyingKey: Buffer.from(prepared.verifyingKey, 'hex'),
      keyDerivation: prepared.keyDerivation
    })
    await wallet.leafManager.addLeaves(
      nodes.filter(node => node.status === 'AVAILABLE')
    )
    const pending = nodes.filter(node => node.status === 'CREATING')
    if (pending.length)
      await wallet.leafManager.addIncomingLeaves(pending, getTxId(tx))
    return nodes.map(mapTreeNodeToWalletLeaf)
  },

  async recover(wallet, data, leaves = [], address) {
    await depositTransaction(wallet, address, data)
    const client = await wallet.connectionManager.createSparkClient(
      wallet.config.getCoordinatorAddress()
    )
    const source = leaves.length
      ? {$case: 'nodeIds', nodeIds: {nodeIds: leaves.map(leaf => leaf.id)}}
      : {
          $case: 'ownerIdentityPubkey',
          ownerIdentityPubkey: await wallet.config.signer.getIdentityPublicKey()
        }
    const matches = new Map()
    for (let offset = 0; ; offset += 100) {
      const page = await client.query_nodes({
        source,
        includeParents: true,
        network: NetworkToProto[wallet.config.getNetwork()],
        statuses: [],
        limit: 100,
        offset
      })
      const nodes = Object.values(page.nodes || {})
      for (const node of nodes) {
        const leaf = mapTreeNodeToWalletLeaf(node)
        if (matchesDeposit(leaf, data)) matches.set(leaf.id, leaf)
      }
      if (leaves.length || nodes.length < 100) break
    }
    return [...matches.values()]
  }
}

export function matchesDeposit(leaf, data) {
  if (!leaf.nodeTx) return false
  const tx = getTxFromRawTxHex(leaf.nodeTx)
  // Single-use deposits have one root input; do not accept an aggregate root.
  if (tx.inputsLength !== 1) return false
  const input = tx.getInput(0)
  return (
    Buffer.from(input.txid).toString('hex') === data.txid &&
    input.index === data.vout
  )
}

export function depositReceipt(leaves, data) {
  if (
    !leaves.length ||
    leaves.some(
      leaf =>
        !Number.isSafeInteger(leaf.value) ||
        leaf.value <= 0 ||
        !matchesDeposit(leaf, data)
    )
  )
    throw new Error('Spark claim does not match deposit outpoint')
  if (leaves.reduce((sum, leaf) => sum + leaf.value, 0) !== data.amount_sats)
    throw new Error('Spark claim does not match deposit amount')
  return leaves.map(leaf => ({
    id: leaf.id,
    value: leaf.value,
    node_tx: leaf.nodeTx,
    // A split/aggregate also proves this root was credited before optimization.
    available: ['AVAILABLE', 'SPLITTED', 'AGGREGATED'].includes(leaf.status)
  }))
}
