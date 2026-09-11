import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {OnchainJournal, OnchainService} from './onchain.mjs'
import {getTxFromRawTxHex, SparkValidationError} from '@buildonspark/spark-sdk'
import {
  decodePayment,
  prepareLightningPayment,
  sendLightningPayment
} from './lightning.mjs'
import {sparkDeposits, depositReceipt} from './spark-deposits.mjs'
import {randomUUID} from 'node:crypto'
import {Readable} from 'node:stream'
import {createOnchainHandler} from './onchain.mjs'

const invoice =
  'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'
const paymentHash = decodePayment(invoice).hash

test('HTTP burst runs different withdrawals concurrently and submits duplicate IDs once', async t => {
  const directory = await mkdtemp('/tmp/spark-volume-test-')
  let active = 0,
    peak = 0,
    sends = 0
  const handler = await createOnchainHandler({
    directory,
    network: 'MAINNET',
    apiKey: 'k'.repeat(32),
    concurrency: 8,
    getWallet: async () => ({
      getBalance: async () => ({balance: 10000000n}),
      getWithdrawalFeeQuote: async () => quote(200),
      withdraw: async () => {
        const id = `withdrawal-${++sends}`
        peak = Math.max(peak, ++active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        return {
          id,
          status: 'COMPLETED',
          fee: money(200),
          l1BroadcastFee: money(0)
        }
      }
    })
  })
  t.after(async () => {
    await handler.close()
    await rm(directory, {recursive: true})
  })
  const ids = Array.from({length: 100}, () => `${randomUUID()}-payout`)
  const start = performance.now()
  const results = await Promise.all(
    [...ids, ...ids].map(async id => {
      const req = Readable.from([Buffer.from(JSON.stringify(request))])
      req.method = 'PUT'
      req.headers = {'x-api-key': 'k'.repeat(32)}
      let code, result
      await handler(
        req,
        {
          writeHead: status => {
            code = status
          },
          end: body => {
            result = JSON.parse(body)
          }
        },
        new URL(`/v1/onchain/withdrawals/${id}`, 'http://localhost')
      )
      assert.equal(code, 200)
      return result
    })
  )
  assert.equal(sends, 100)
  assert.equal(peak, 8)
  for (let i = 0; i < 100; i++) assert.deepEqual(results[i], results[i + 100])
  const elapsed = performance.now() - start
  t.diagnostic(
    `Mock outbound burst: 100 withdrawals / ${elapsed.toFixed(0)} ms (${(100000 / elapsed).toFixed(1)}/s), 20 ms SDK latency; not live Spark throughput`
  )
})

test('long Lightning history scans continue across polls with a two-page work budget', async t => {
  let calls = 0
  const {service} = await setup(t, {
    getUserRequests: async ({after}) => {
      calls++
      const page = Number(after || 0)
      return {
        entities:
          page === 0
            ? [
                {
                  id: 'success',
                  typename: 'LightningSendRequest',
                  invoice: {paymentHash},
                  status: 'LIGHTNING_PAYMENT_SUCCEEDED',
                  fee: money(0)
                }
              ]
            : [],
        pageInfo: {hasNextPage: page < 4, endCursor: String(page + 1)}
      }
    }
  })
  assert.equal((await service.lightning(paymentHash)).status, 'UNKNOWN')
  assert.equal(calls, 2)
  assert.equal((await service.lightning(paymentHash)).status, 'UNKNOWN')
  assert.equal(calls, 4)
  assert.equal(
    (await service.lightning(paymentHash)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  assert.equal(calls, 5)
})

function rootTx(txid, vout) {
  const index = Buffer.alloc(4)
  index.writeUInt32LE(vout)
  return (
    '0200000001' +
    Buffer.from(txid, 'hex').reverse().toString('hex') +
    index.toString('hex') +
    '00ffffffff011027000000000000015100000000'
  )
}
const claimData = {txid: 'a'.repeat(64), vout: 0, amount_sats: 10000}
const leaf = (status = 'AVAILABLE', data = claimData) => ({
  id: 'leaf',
  status,
  value: data.amount_sats,
  nodeTx: rootTx(data.txid, data.vout)
})

const money = amount => ({originalUnit: 'SATOSHI', originalValue: amount})
const quote = fee => ({
  id: 'quote',
  userFeeMedium: money(fee),
  l1BroadcastFeeMedium: money(0),
  expiresAt: new Date(Date.now() + 60000).toISOString()
})
const request = {
  address: 'bc1qexampleaddress',
  amount_sats: 10000,
  max_fee_sats: 1000
}

async function setup(t, wallet, deposits) {
  wallet = {
    getLightningSendFeeEstimate: async () => 0,
    getBalance: async () => ({balance: 1000000n}),
    ...wallet
  }
  const directory = await mkdtemp(
    path.join(tmpdir(), 'swapsatsprivate-sidecar-')
  )
  const journal = new OnchainJournal(directory)
  await journal.initialize()
  t.after(async () => {
    await journal.close()
    await rm(directory, {recursive: true})
  })
  return {
    journal,
    directory,
    service: new OnchainService({
      journal,
      getWallet: async () => wallet,
      network: 'MAINNET',
      fundsWaitMs: 0,
      deposits
    })
  }
}

test('concurrent duplicate withdrawals send once and survive restart', async t => {
  let sent = 0
  const wallet = {
    getWithdrawalFeeQuote: async () => quote(200),
    withdraw: async () => {
      sent++
      return {
        id: 'external-id',
        status: 'TX_BROADCASTED',
        coopExitTxid: 'a'.repeat(64),
        fee: money(100),
        l1BroadcastFee: money(100)
      }
    },
    getCoopExitRequest: async () => ({
      status: 'SUCCEEDED',
      coopExitTxid: 'a'.repeat(64),
      fee: money(100),
      l1BroadcastFee: money(100)
    })
  }
  const {journal, service} = await setup(t, wallet)
  await Promise.all(
    Array.from({length: 10}, () =>
      service.serial(() => service.withdraw('swap-payout', request))
    )
  )
  assert.equal(sent, 1)
  const restarted = new OnchainService({
    journal,
    getWallet: async () => wallet,
    network: 'REGTEST'
  })
  await restarted.withdraw('swap-payout', request)
  assert.equal(sent, 1)
  assert.equal((await restarted.withdrawal('swap-payout')).status, 'SUCCEEDED')
  await assert.rejects(
    restarted.withdraw('swap-payout', {...request, amount_sats: 11000})
  )
})

test('lost withdrawal response is never retried or reported as rejected', async t => {
  let sent = 0
  const {service, journal} = await setup(t, {
    getWithdrawalFeeQuote: async () => quote(200),
    withdraw: async () => {
      sent++
      throw new Error('socket closed after send')
    }
  })
  assert.equal(
    (await service.withdraw('swap-payout', request)).status,
    'unknown'
  )
  const restarted = new OnchainService({
    journal,
    getWallet: async () => {
      throw new Error('must not send')
    },
    network: 'REGTEST'
  })
  assert.equal(
    (await restarted.withdraw('swap-payout', request)).status,
    'unknown'
  )
  assert.equal(sent, 1)
})

test('fee cap rejects before calling withdrawal', async t => {
  const {service} = await setup(t, {
    getWithdrawalFeeQuote: async () => quote(1001),
    withdraw: async () => assert.fail('must not send above cap')
  })
  assert.equal(
    (await service.withdraw('swap-payout', request)).status,
    'rejected'
  )
})

test('durability failure prevents sending', async t => {
  const {service, journal} = await setup(t, {
    withdraw: async () => assert.fail('must not send')
  })
  journal.put = async () => {
    throw new Error('disk full')
  }
  await assert.rejects(service.withdraw('swap-payout', request))
})

test('journal corruption fails closed and exclusive writer lock is enforced', async t => {
  const {directory, journal} = await setup(t, {})
  await writeFile(path.join(directory, 'bad.json'), '{corrupt')
  await assert.rejects(journal.get('bad'))
  await assert.rejects(new OnchainJournal(directory).initialize())
  await journal.put('good', {state: 'submitted'})
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, 'good.json'), 'utf8')),
    {state: 'submitted'}
  )
})

test('deposit addresses are unique and pending receipts recover without another claim', async t => {
  let addresses = 0,
    claims = 0,
    available = false
  const wallet = {
    getSingleUseDepositAddress: async () => `address-${++addresses}`
  }
  const deposits = {
    prepare: async () => ({vout: 0}),
    claim: async () => {
      claims++
      return [leaf('CREATING')]
    },
    recover: async () => (available ? [leaf()] : [])
  }
  const {service} = await setup(t, wallet, deposits)
  assert.equal(
    (await service.address('one')).address,
    (await service.address('one')).address
  )
  assert.notEqual(
    (await service.address('one')).address,
    (await service.address('two')).address
  )
  assert.equal((await service.claim('one', claimData)).available, false)
  available = true
  assert.equal((await service.claim('one', claimData)).available, true)
  assert.equal(claims, 1)
  await assert.rejects(service.claim('one', {...claimData, vout: 1}))
})

test('Lightning request ID survives restart and duplicate calls do not resend', async t => {
  let payments = 0
  const wallet = {
    payLightningInvoice: async () => {
      payments++
      return {id: 'ln-request'}
    },
    getLightningSendRequest: async () => ({
      status: 'LIGHTNING_PAYMENT_SUCCEEDED',
      fee: money(2),
      paymentPreimage: 'preimage'
    })
  }
  const {service, journal} = await setup(t, wallet)
  const hash = paymentHash
  const data = {bolt11: invoice, max_fee_sats: 10}
  assert.equal(
    (await service.lightning(hash, data)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  const restarted = new OnchainService({
    journal,
    getWallet: async () => wallet,
    network: 'REGTEST'
  })
  assert.equal((await restarted.lightning(hash)).fee_msat, 2000)
  await restarted.lightning(hash, data)
  assert.equal(payments, 1)
})

test('ambiguous Lightning failure retains a durable pending intent', async t => {
  let payments = 0
  const {service} = await setup(t, {
    payLightningInvoice: async () => {
      payments++
      throw new Error('lost response')
    }
  })
  const hash = paymentHash
  const data = {bolt11: invoice, max_fee_sats: 10}
  assert.equal((await service.lightning(hash, data)).status, 'UNKNOWN')
  assert.equal((await service.lightning(hash, data)).status, 'UNKNOWN')
  assert.equal(payments, 1)
})

for (const [unit, value] of [
  ['MILLISATOSHI', 2000],
  ['BITCOIN', 2e-8]
]) {
  test(`Lightning fee conversion supports ${unit} without rounding`, async t => {
    const {service} = await setup(t, {
      payLightningInvoice: async () => ({id: 'request'}),
      getLightningSendRequest: async () => ({
        status: 'LIGHTNING_PAYMENT_SUCCEEDED',
        fee: {originalUnit: unit, originalValue: value}
      })
    })
    assert.equal(
      (
        await service.lightning(paymentHash, {
          bolt11: invoice,
          max_fee_sats: 10
        })
      ).fee_msat,
      2000
    )
  })
}

for (const [unit, value] of [
  ['MILLISATOSHI', 200000],
  ['BITCOIN', 0.000002]
]) {
  test(`withdrawal fee cap uses normalized ${unit} in SDK dispatch`, async t => {
    const {service} = await setup(t, {
      getWithdrawalFeeQuote: async () => ({
        ...quote(0),
        userFeeMedium: {originalUnit: unit, originalValue: value}
      }),
      withdraw: async params => {
        assert.equal(params.feeAmountSats, 200)
        assert.equal(params.feeQuoteId, 'quote')
        assert.equal(params.feeQuote, undefined)
        assert.equal(params.deductFeeFromWithdrawalAmount, false)
        return {
          id: 'exit',
          status: 'TX_BROADCASTED',
          fee: money(200),
          l1BroadcastFee: money(0)
        }
      }
    })
    assert.equal((await service.withdraw('swap-payout', request)).fee_sats, 200)
  })
}

test('HTTP handler authenticates every financial route before accessing the wallet', async t => {
  const {createOnchainHandler} = await import('./onchain.mjs')
  const directory = await mkdtemp(path.join(tmpdir(), 'swapsatsprivate-auth-'))
  const apiKey = 'k'.repeat(43)
  const handler = await createOnchainHandler({
    directory,
    network: 'REGTEST',
    apiKey,
    getWallet: async () =>
      assert.fail('unauthorized or info request accessed wallet')
  })
  t.after(async () => {
    await handler.close()
    await rm(directory, {recursive: true})
  })
  const uuid = '00000000-0000-4000-8000-000000000000'
  const paths = [
    ['GET', '/v1/onchain/info'],
    ['PUT', `/v1/onchain/deposits/${uuid}`],
    ['POST', `/v1/onchain/deposits/${uuid}/claim`],
    ['PUT', `/v1/onchain/withdrawals/${uuid}-refund`],
    ['POST', '/v1/payments']
  ]
  for (const [method, resource] of paths) {
    for (const supplied of [undefined, 'x'.repeat(43), [apiKey]]) {
      let status
      const response = {
        writeHead: code => {
          status = code
        },
        end: () => {}
      }
      await handler(
        {method, headers: {'x-api-key': supplied}},
        response,
        new URL(resource, 'http://localhost')
      )
      assert.equal(status, 401)
    }
  }
  let status, result
  await handler(
    {method: 'GET', headers: {'x-api-key': apiKey}},
    {
      writeHead: code => {
        status = code
      },
      end: body => {
        result = JSON.parse(body)
      }
    },
    new URL('/v1/onchain/info', 'http://localhost')
  )
  assert.equal(status, 200)
  assert.equal(result.required_confirmations, 3)
})

test('a transient claim preparation failure can be retried', async t => {
  let preparations = 0,
    claims = 0
  const {service} = await setup(
    t,
    {getSingleUseDepositAddress: async () => 'address'},
    {
      recover: async () => [],
      prepare: async () => {
        if (++preparations === 1)
          throw new Error('transaction fetch unavailable')
        return {vout: 0}
      },
      claim: async () => {
        claims++
        return [leaf()]
      }
    }
  )
  await service.address('swap')
  await assert.rejects(service.claim('swap', claimData))
  assert.equal((await service.claim('swap', claimData)).available, true)
  assert.equal(claims, 1)
})

test('a lost claim response recovers its receipt after restart without claiming again', async t => {
  let claimed = false,
    calls = 0
  const wallet = {getSingleUseDepositAddress: async () => 'address'}
  const deposits = {
    recover: async () => (claimed ? [leaf()] : []),
    prepare: async () => ({vout: 0}),
    claim: async () => {
      calls++
      claimed = true
      throw new Error('lost response')
    }
  }
  const {service, journal} = await setup(t, wallet, deposits)
  await service.address('swap')
  await assert.rejects(service.claim('swap', claimData))
  const restarted = new OnchainService({
    journal,
    getWallet: async () => wallet,
    deposits
  })
  assert.equal((await restarted.claim('swap', claimData)).available, true)
  assert.equal(calls, 1)
})

test('claim retry remains bound to the same prepared output', async t => {
  let calls = 0
  const prepared = {vout: 0, txHex: 'fixed-transaction'}
  const {service} = await setup(
    t,
    {getSingleUseDepositAddress: async () => 'address'},
    {
      recover: async () => [],
      prepare: async () => prepared,
      claim: async (_wallet, params) => {
        assert.deepEqual(params, prepared)
        if (++calls === 1) throw new Error('temporary signing failure')
        return [leaf()]
      }
    }
  )
  await service.address('swap')
  await assert.rejects(service.claim('swap', claimData))
  assert.equal((await service.claim('swap', claimData)).available, true)
  assert.equal(calls, 2)
})

test('a receipt from another output is never attached to a swap', async t => {
  const {service, journal} = await setup(
    t,
    {getSingleUseDepositAddress: async () => 'address'},
    {
      recover: async () => [],
      prepare: async () => ({vout: 0}),
      claim: async () => [leaf('AVAILABLE', {...claimData, vout: 1})]
    }
  )
  await service.address('swap')
  await assert.rejects(service.claim('swap', claimData), /outpoint/)
  assert.equal((await journal.get('swap')).leaves, undefined)
})

test('address allocation can recover when the first response was never persisted', async t => {
  let calls = 0
  const {service} = await setup(t, {
    getSingleUseDepositAddress: async () => {
      if (++calls === 1) throw new Error('temporary failure')
      return 'address'
    }
  })
  await assert.rejects(service.address('swap'))
  assert.equal((await service.address('swap')).address, 'address')
})

test('SDK adapter finalizes the requested output in a batched deposit', async () => {
  const {getP2TRAddressFromPkScript, getTxId, Network, KeyDerivationType} =
    await import('@buildonspark/spark-sdk')
  // Two distinct P2TR outputs, with a valid secp256k1 x coordinate in each.
  const keys = [
    '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  ]
  const tx = getTxFromRawTxHex(
    '0200000001' +
      '11'.repeat(32) +
      '0000000000ffffffff02' +
      keys.map(key => '1027000000000000225120' + key).join('') +
      '00000000'
  )
  const addresses = keys.map(key =>
    getP2TRAddressFromPkScript(
      Buffer.from('5120' + key, 'hex'),
      Network.MAINNET
    )
  )
  let finalized, nodesAdded
  const wallet = {
    config: {
      getNetwork: () => Network.MAINNET,
      signer: {getIdentityPublicKey: async () => new Uint8Array(33)}
    },
    getDepositTransaction: async () => tx,
    queryAllUnusedDepositAddresses: async () =>
      addresses.map((address, i) => ({
        depositAddress: address,
        leafId: `leaf-${i}`,
        verifyingPublicKey: Buffer.from(keys[i], 'hex')
      })),
    finalizeDeposit: async params => {
      finalized = params
      return []
    },
    leafManager: {
      addLeaves: async nodes => {
        nodesAdded = nodes
      }
    }
  }
  const data = {txid: getTxId(tx), vout: 1, amount_sats: 10000}
  const prepared = await sparkDeposits.prepare(wallet, addresses[1], data)
  await sparkDeposits.claim(wallet, prepared)
  assert.equal(finalized.vout, 1)
  assert.deepEqual(finalized.keyDerivation, {
    type: KeyDerivationType.LEAF,
    path: 'leaf-1'
  })
  assert.equal(getTxId(finalized.depositTx), data.txid)
  assert.deepEqual(nodesAdded, [])
  const node = (index, status) => ({
    id: `node-${index}`,
    value: 10000,
    status,
    network: 0,
    nodeTx: Buffer.from(rootTx(data.txid, index), 'hex'),
    refundTx: new Uint8Array(),
    verifyingPublicKey: new Uint8Array(),
    ownerIdentityPublicKey: new Uint8Array()
  })
  wallet.config.getCoordinatorAddress = () => 'coordinator'
  wallet.connectionManager = {
    createSparkClient: async () => ({
      query_nodes: async params => {
        assert.equal(params.includeParents, true)
        return {
          nodes: {first: node(0, 'AVAILABLE'), second: node(1, 'SPLITTED')}
        }
      }
    })
  }
  const recovered = await sparkDeposits.recover(wallet, data, [], addresses[1])
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].id, 'node-1')
  assert.equal(depositReceipt(recovered, data)[0].available, true)

  await assert.rejects(
    sparkDeposits.prepare(wallet, addresses[0], data),
    /does not match/
  )
})

for (const reason of ['fee', 'balance', 'network', 'invoice']) {
  test(`Lightning ${reason} rejection returns durable failure without sending`, async t => {
    let calls = 0
    const {service} = await setup(t, {
      getLightningSendFeeEstimate: async () => (reason === 'fee' ? 11 : 0),
      getBalance: async () => ({balance: reason === 'balance' ? 0n : 1000000n}),
      payLightningInvoice: async () => {
        calls++
        assert.fail('must not send')
      }
    })
    if (reason === 'network') service.network = 'REGTEST'
    const result = await service.lightning(paymentHash, {
      bolt11: reason === 'invoice' ? 'invalid' : invoice,
      max_fee_sats: 10
    })
    assert.equal(result.status, 'LIGHTNING_PAYMENT_FAILED')
    assert.equal(
      (await service.lightning(paymentHash)).status,
      'LIGHTNING_PAYMENT_FAILED'
    )
    assert.equal(calls, 0)
  })
}

test('only known pre-dispatch SDK validation errors are terminal failures', async () => {
  const safe = new SparkValidationError(
    'maxFeeSats does not cover fee estimate'
  )
  const unsafe = new SparkValidationError('Invalid SSP response after send')
  assert.equal(
    (
      await sendLightningPayment(
        {
          payLightningInvoice: async () => {
            throw safe
          }
        },
        {}
      )
    ).status,
    'LIGHTNING_PAYMENT_FAILED'
  )
  await assert.rejects(
    sendLightningPayment(
      {
        payLightningInvoice: async () => {
          throw unsafe
        }
      },
      {}
    )
  )
})

test('lost Lightning response reconciles by hash through paginated Spark history', async t => {
  let sends = 0
  const {service} = await setup(t, {
    payLightningInvoice: async () => {
      sends++
      throw new Error('response lost')
    },
    getUserRequests: async ({after}) =>
      after
        ? {
            entities: [
              {
                id: 'recovered',
                typename: 'LightningSendRequest',
                invoice: {paymentHash},
                status: 'LIGHTNING_PAYMENT_SUCCEEDED',
                paymentPreimage: 'proof',
                fee: money(2)
              }
            ],
            pageInfo: {hasNextPage: false}
          }
        : {entities: [], pageInfo: {hasNextPage: true, endCursor: 'next'}}
  })
  const result = await service.lightning(paymentHash, {
    bolt11: invoice,
    max_fee_sats: 10
  })
  assert.equal(result.status, 'LIGHTNING_PAYMENT_SUCCEEDED')
  assert.equal(result.preimage, 'proof')
  await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10})
  assert.equal(sends, 1)
})

test('a terminal send response survives an unavailable status lookup', async t => {
  const {service} = await setup(t, {
    payLightningInvoice: async () => ({
      id: 'request',
      status: 'LIGHTNING_PAYMENT_SUCCEEDED',
      paymentPreimage: 'proof',
      fee: money(1)
    }),
    getLightningSendRequest: async () => {
      throw new Error('lookup unavailable')
    }
  })
  const result = await service.lightning(paymentHash, {
    bolt11: invoice,
    max_fee_sats: 10
  })
  assert.equal(result.status, 'LIGHTNING_PAYMENT_SUCCEEDED')
  assert.equal(result.preimage, 'proof')
  assert.equal(result.fee_msat, 1000)
})

test('historical Lightning payments without a journal entry can still be looked up', async t => {
  const {service} = await setup(t, {
    getUserRequests: async () => ({
      entities: [
        {
          id: 'old-payment',
          typename: 'LightningSendRequest',
          invoice: {paymentHash},
          status: 'LIGHTNING_PAYMENT_SUCCEEDED',
          fee: money(1)
        }
      ],
      pageInfo: {hasNextPage: false}
    })
  })
  assert.equal(
    (await service.lightning(paymentHash)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
})

test('Lightning-only HTTP mode preserves authentication, hash derivation and failed status', async t => {
  const {Readable} = await import('node:stream')
  const {createOnchainHandler} = await import('./onchain.mjs')
  const directory = await mkdtemp(
    path.join(tmpdir(), 'sidecar-lightning-http-')
  )
  const handler = await createOnchainHandler({
    directory,
    network: 'MAINNET',
    apiKey: 'legacy-short-key',
    onchainEnabled: false,
    getWallet: async () => ({
      getLightningSendFeeEstimate: async () => 100,
      payLightningInvoice: async () =>
        assert.fail('over-cap payment must not send')
    })
  })
  t.after(async () => {
    await handler.close()
    await rm(directory, {recursive: true})
  })
  async function request(method, resource, data, key = 'legacy-short-key') {
    const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : [])
    req.method = method
    req.headers = {'x-api-key': key}
    let status, result
    const handled = await handler(
      req,
      {
        writeHead: code => {
          status = code
        },
        end: value => {
          result = JSON.parse(value)
        }
      },
      new URL(resource, 'http://localhost')
    )
    return {handled, status, result}
  }
  assert.equal((await request('GET', '/v1/onchain/info')).handled, false)
  assert.equal(
    (
      await request(
        'POST',
        '/v1/payments',
        {bolt11: invoice, max_fee_sats: 10},
        'bad'
      )
    ).status,
    401
  )
  const sent = await request('POST', '/v1/payments', {
    bolt11: invoice,
    max_fee_sats: 10
  })
  assert.equal(sent.status, 200)
  assert.equal(sent.result.checking_id, paymentHash)
  assert.equal(sent.result.status, 'LIGHTNING_PAYMENT_FAILED')
  assert.equal(
    (await request('GET', `/v1/payments/${paymentHash.toUpperCase()}`)).result
      .status,
    'LIGHTNING_PAYMENT_FAILED'
  )
  assert.equal(
    (
      await request('POST', '/v1/payments', {
        bolt11: invoice,
        max_fee_sats: 10,
        payment_hash: '00'.repeat(32)
      })
    ).status,
    409
  )
})

test('ambiguous Lightning history never proves failure or causes a resend', async t => {
  let sends = 0
  const {service} = await setup(t, {
    payLightningInvoice: async () => {
      sends++
      throw new Error('lost response')
    },
    getUserRequests: async () => ({
      entities: [1, 2].map(id => ({
        id: String(id),
        typename: 'LightningSendRequest',
        invoice: {paymentHash},
        status: 'LIGHTNING_PAYMENT_FAILED'
      })),
      pageInfo: {hasNextPage: false}
    })
  })
  assert.equal(
    (await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10}))
      .status,
    'UNKNOWN'
  )
  assert.equal(
    (await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10}))
      .status,
    'UNKNOWN'
  )
  assert.equal(sends, 1)
})

test('a known pre-dispatch rejection can be retried after correcting its fee cap', async t => {
  let sends = 0
  const {service} = await setup(t, {
    getLightningSendFeeEstimate: async () => 20,
    payLightningInvoice: async () => {
      sends++
      return {
        id: 'request',
        status: 'LIGHTNING_PAYMENT_SUCCEEDED',
        fee: money(20)
      }
    }
  })
  assert.equal(
    (await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10}))
      .status,
    'LIGHTNING_PAYMENT_FAILED'
  )
  assert.equal(
    (await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 20}))
      .status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 20})
  assert.equal(sends, 1)
})

for (const oldStatus of ['LIGHTNING_PAYMENT_FAILED', 'CREATED']) {
  test(`an older ${oldStatus} attempt cannot resolve a newer ambiguous send`, async t => {
    let sends = 0
    const {service, journal} = await setup(t, {
      payLightningInvoice: async () => {
        sends++
        throw new Error('lost response after new send')
      },
      getUserRequests: async () => ({
        entities: [
          {
            id: 'old-attempt',
            typename: 'LightningSendRequest',
            invoice: {paymentHash},
            createdAt: '2020-01-01T00:00:00Z',
            status: oldStatus
          }
        ],
        pageInfo: {hasNextPage: false}
      }),
      getLightningSendRequest: async () =>
        assert.fail('must not bind the old request ID')
    })
    assert.equal(
      (
        await service.lightning(paymentHash, {
          bolt11: invoice,
          max_fee_sats: 10
        })
      ).status,
      'UNKNOWN'
    )
    assert.equal((await journal.get(`ln-${paymentHash}`)).request_id, undefined)
    assert.equal((await service.lightning(paymentHash)).status, 'UNKNOWN')
    assert.equal(sends, 1)
  })
}

test('Lightning waits for locally locked funds even when the coordinator shows a balance', async t => {
  let available = 0n,
    sends = 0
  const {service} = await setup(t, {
    getBalance: async () => ({balance: 100000n}),
    getCachedBalance: async () => ({
      satsBalance: {available, owned: 100000n, incoming: 0n}
    }),
    payLightningInvoice: async () => {
      sends++
      return {id: 'payment', status: 'LIGHTNING_PAYMENT_SUCCEEDED'}
    }
  })
  assert.equal(
    (await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10}))
      .status,
    'WAITING_FOR_FUNDS'
  )
  assert.equal(sends, 0)
  available = 100000n
  assert.equal(
    (await service.lightning(paymentHash)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  await service.lightning(paymentHash)
  assert.equal(sends, 1)
})

test('incoming Lightning funds keep the original intent pending across restart until spendable', async t => {
  let available = 0n,
    sends = 0
  const {service, journal} = await setup(t, {
    getBalance: async () => ({
      satsBalance: {
        available,
        owned: available,
        incoming: available ? 0n : 100000n
      }
    }),
    payLightningInvoice: async () => {
      sends++
      return {id: 'payment', status: 'LIGHTNING_PAYMENT_SUCCEEDED'}
    }
  })
  assert.equal(
    (await service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10}))
      .status,
    'WAITING_FOR_FUNDS'
  )
  const restarted = new OnchainService({
    journal,
    getWallet: service.getWallet,
    network: 'MAINNET',
    fundsWaitMs: 0
  })
  assert.equal(
    (await restarted.lightning(paymentHash)).status,
    'WAITING_FOR_FUNDS'
  )
  assert.equal(sends, 0)
  available = 100000n
  assert.equal(
    (await restarted.lightning(paymentHash)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  assert.equal(sends, 1)
})

test('a missing-balance grace period waits without blocking other queued operations', async t => {
  let sends = 0
  const {service, journal} = await setup(t, {
    getBalance: async () => ({balance: 0n}),
    getSingleUseDepositAddress: async () => 'deposit-address',
    payLightningInvoice: async () => {
      sends++
      assert.fail('must not send without funds')
    }
  })
  service.fundsWaitMs = 60000
  assert.equal(
    (
      await service.serial(() =>
        service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10})
      )
    ).status,
    'WAITING_FOR_FUNDS'
  )
  assert.equal(
    (await service.serial(() => service.address('swap'))).address,
    'deposit-address'
  )
  const record = await journal.get(`ln-${paymentHash}`)
  record.funds_deadline = Date.now() - 1
  await journal.put(`ln-${paymentHash}`, record)
  assert.equal(
    (await service.lightning(paymentHash)).status,
    'LIGHTNING_PAYMENT_FAILED'
  )
  assert.equal(sends, 0)
})

test('withdrawal waits for spendable funds including fees and resumes on status polling', async t => {
  let available = 10000n,
    sends = 0,
    quotes = 0
  const {service} = await setup(t, {
    getBalance: async () => ({
      satsBalance: {available, owned: 10200n, incoming: 0n}
    }),
    getWithdrawalFeeQuote: async () => {
      quotes++
      return quote(200)
    },
    withdraw: async () => {
      sends++
      return {
        id: 'exit',
        status: 'TX_BROADCASTED',
        coopExitTxid: 'a'.repeat(64),
        fee: money(200),
        l1BroadcastFee: money(0)
      }
    }
  })
  assert.equal(
    (await service.withdraw('swap-payout', request)).status,
    'WAITING_FOR_FUNDS'
  )
  assert.equal(sends, 0)
  available = 10200n
  assert.equal(
    (await service.withdrawal('swap-payout')).status,
    'TX_BROADCASTED'
  )
  assert.equal(sends, 1)
  assert.equal(quotes, 2)
})
