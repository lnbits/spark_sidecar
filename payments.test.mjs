import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {Readable} from 'node:stream'
import {bech32} from '@scure/base'
import {PaymentJournal} from './payment-journal.mjs'
import {PaymentService, createPaymentHandler} from './payments.mjs'
import {
  SparkValidationError,
  SparkWallet,
  Network
} from '@buildonspark/spark-sdk'
import {
  decodePayment,
  prepareLightningPayment,
  sendLightningPayment
} from './lightning.mjs'

const invoice =
  'lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567'
const paymentHash = decodePayment(invoice).hash

test('preflight and SDK dispatch enforce the same fee limit for either invoice case', async () => {
  const wallet = Object.create(SparkWallet.prototype)
  wallet.config = {getNetwork: () => Network.MAINNET}
  wallet.getSspClient = () => ({
    getLightningSendFeeEstimate: async encodedInvoice => {
      assert.equal(encodedInvoice, invoice)
      return {feeEstimate: {originalUnit: 'SATOSHI', originalValue: 5}}
    }
  })
  wallet.getBalance = async () => ({balance: 1000000n})
  wallet.getCachedBalance = wallet.getBalance
  wallet.leafManager = {
    // Stop at leaf selection: the actual SDK's normalization and fee path run,
    // but no transfer callback, signing, or network request is permitted.
    selectLeavesAndExecute: async amounts => {
      assert.deepEqual(amounts, [2005])
      return {id: 'fixture-send', status: 'LIGHTNING_PAYMENT_SUCCEEDED'}
    }
  }
  for (const encoded of [invoice, invoice.toUpperCase()]) {
    const params = {invoice: encoded, maxFeeSats: 2}
    await assert.rejects(prepareLightningPayment(wallet, params, 'MAINNET'), {
      code: 'FEE_LIMIT_EXCEEDED'
    })
    await assert.rejects(wallet.payLightningInvoice(params), {
      initialMessage: 'maxFeeSats does not cover fee estimate'
    })
    params.maxFeeSats = 5
    await prepareLightningPayment(wallet, params, 'MAINNET')
    assert.equal(
      (await wallet.payLightningInvoice(params)).status,
      'LIGHTNING_PAYMENT_SUCCEEDED'
    )
  }
})

test('preflight failures persist safe reasons without exposing SDK error contents', async t => {
  const secret = 'MOCK_MNEMONIC_MUST_NOT_LEAK'
  const logs = []
  t.mock.method(console, 'warn', message => logs.push(message))
  for (const [method, code] of [
    ['getLightningSendFeeEstimate', 'FEE_QUOTE_UNAVAILABLE'],
    ['getBalance', 'BALANCE_UNAVAILABLE']
  ]) {
    const {service, journal} = await setup(t, {
      [method]: async () => {
        throw new Error(secret)
      },
      payLightningInvoice: async () => assert.fail('must not dispatch')
    })
    const result = await service.lightning(paymentHash, {
      bolt11: invoice,
      max_fee_sats: 2
    })
    assert.equal(result.status, 'LIGHTNING_PAYMENT_FAILED')
    assert.equal(result.failure_code, code)
    const saved = await journal.get(`ln-${paymentHash}`)
    assert.equal(saved.not_sent, true)
    assert.equal(saved.failure_code, code)
    assert.equal((await service.lightning(paymentHash)).failure_code, code)
    assert(!JSON.stringify([result, saved, logs]).includes(secret))
  }
})

test('concurrent HTTP payments retain independent queues and suppress duplicate sends', async t => {
  const directory = await mkdtemp('/tmp/spark-lightning-volume-')
  let active = 0,
    peak = 0
  const sent = new Set()
  const handler = await createPaymentHandler({
    directory,
    network: 'MAINNET',
    apiKey: 'test-key',
    concurrency: 8,
    getWallet: async () => ({
      getBalance: async () => ({balance: 10000000n}),
      getLightningSendFeeEstimate: async () => 0,
      payLightningInvoice: async ({invoice}) => {
        const hash = decodePayment(invoice).hash
        assert(!sent.has(hash))
        sent.add(hash)
        peak = Math.max(peak, ++active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        return {id: hash, status: 'LIGHTNING_PAYMENT_SUCCEEDED', fee: money(0)}
      }
    })
  })
  t.after(async () => {
    await handler.close()
    await rm(directory, {recursive: true})
  })
  // Synthetic invoice hashes exercise HTTP routing; the sending wallet is mocked.
  const encoded = bech32.decode(invoice, 5000)
  const invoices = Array.from({length: 100}, (_, index) => {
    const words = [...encoded.words]
    assert.equal(words[7], 1) // BOLT11 payment_hash tag in the fixture.
    const hash = Buffer.from(index.toString(16).padStart(64, '0'), 'hex')
    words.splice(10, 52, ...bech32.toWords(hash))
    return bech32.encode(encoded.prefix, words, 5000)
  })
  const results = await Promise.all(
    [...invoices, ...invoices].map(async bolt11 => {
      const req = Readable.from([
        Buffer.from(JSON.stringify({bolt11, max_fee_sats: 10}))
      ])
      req.method = 'POST'
      req.headers = {'x-api-key': 'test-key'}
      let code, response
      await handler(
        req,
        {
          writeHead: value => {
            code = value
          },
          end: value => {
            response = JSON.parse(value)
          }
        },
        new URL('/v1/payments', 'http://localhost')
      )
      assert.equal(code, 200)
      assert.equal(response.status, 'LIGHTNING_PAYMENT_SUCCEEDED')
      return response
    })
  )
  assert.equal(sent.size, 100)
  assert.equal(peak, 8)
  for (let i = 0; i < 100; i++) assert.deepEqual(results[i], results[i + 100])
})

const money = amount => ({originalUnit: 'SATOSHI', originalValue: amount})
async function setup(t, wallet) {
  wallet = {
    getLightningSendFeeEstimate: async () => 0,
    getBalance: async () => ({balance: 1000000n}),
    ...wallet
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'spark-payments-'))
  const journal = new PaymentJournal(directory)
  await journal.initialize()
  t.after(async () => {
    await journal.close()
    await rm(directory, {recursive: true})
  })
  return {
    journal,
    directory,
    service: new PaymentService({
      journal,
      getWallet: async () => wallet,
      network: 'MAINNET',
      fundsWaitMs: 0
    })
  }
}

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

test('durability failure prevents sending', async t => {
  const {service, journal} = await setup(t, {
    payLightningInvoice: async () => assert.fail('must not send')
  })
  journal.put = async () => {
    throw new Error('disk full')
  }
  await assert.rejects(
    service.lightning(paymentHash, {bolt11: invoice, max_fee_sats: 10})
  )
})

test('journal corruption fails closed and exclusive writer lock is enforced', async t => {
  const {directory, journal} = await setup(t, {})
  await writeFile(path.join(directory, 'bad.json'), '{corrupt')
  await assert.rejects(journal.get('bad'))
  await assert.rejects(new PaymentJournal(directory).initialize())
  await journal.put('good', {state: 'submitted'})
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, 'good.json'), 'utf8')),
    {state: 'submitted'}
  )
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
  const restarted = new PaymentService({
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
    if (reason === 'fee') {
      assert.equal(result.failure_code, 'FEE_LIMIT_EXCEEDED')
      assert.equal(
        result.error_message,
        'Spark fee quote (11 sats) exceeds the payment fee limit (10 sats)'
      )
      assert.equal(
        (await service.lightning(paymentHash)).error_message,
        result.error_message
      )
    }
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
  const directory = await mkdtemp(
    path.join(tmpdir(), 'sidecar-lightning-http-')
  )
  const handler = await createPaymentHandler({
    directory,
    network: 'MAINNET',
    apiKey: 'legacy-short-key',
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
  const restarted = new PaymentService({
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
    await service.serial(async () => 'other-work', 'other-payment'),
    'other-work'
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
