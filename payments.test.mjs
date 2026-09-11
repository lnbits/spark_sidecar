import assert from 'node:assert/strict'
import test from 'node:test'
import {Readable} from 'node:stream'
import {bech32} from '@scure/base'
import {
  SparkValidationError,
  SparkWallet,
  Network
} from '@buildonspark/spark-sdk'
import {PaymentService, createPaymentHandler} from './payments.mjs'
import {
  decodePayment,
  prepareLightningPayment,
  sendLightningPayment
} from './lightning.mjs'

import {invoice} from './test/invoice.mjs'
const paymentHash = decodePayment(invoice).hash
const money = value => ({originalUnit: 'SATOSHI', originalValue: value})
const data = {bolt11: invoice, max_fee_sats: 10}
const request = (
  status = 'LIGHTNING_PAYMENT_SUCCEEDED',
  id = 'spark-request'
) => ({
  id,
  typename: 'LightningSendRequest',
  status,
  invoice: {paymentHash},
  fee: money(2),
  paymentPreimage: 'proof'
})
const page = (entities = [], after) => ({
  entities,
  pageInfo: {hasNextPage: Boolean(after), endCursor: after}
})
function setup(t, overrides = {}, config = {}) {
  const wallet = {
    getBalance: async () => ({balance: 1000000n}),
    getLightningSendFeeEstimate: async () => 0,
    getUserRequests: async () => page(),
    getLightningSendRequest: async () => null,
    payLightningInvoice: async () => request(),
    ...overrides
  }
  const options = {
    getWallet: async () => wallet,
    network: 'MAINNET',
    fundsWaitMs: 0,
    ...config
  }
  const service = new PaymentService(options)
  t.after(() => service.operations.close())
  return {wallet, service, options}
}

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

test('the pinned SDK passes the sidecar idempotency key to its preimage-swap service', async t => {
  const sdk = Object.create(SparkWallet.prototype)
  const keys = []
  sdk.config = {
    getNetwork: () => Network.MAINNET,
    getSspIdentityPublicKey: () => `02${'1'.repeat(64)}`
  }
  sdk.getSspClient = () => ({
    getUserRequests: async () => page(),
    getLightningSendFeeEstimate: async () => ({
      feeEstimate: {originalUnit: 'SATOSHI', originalValue: 1}
    }),
    requestLightningSend: async ({userOutboundTransferExternalId}) => {
      assert.equal(userOutboundTransferExternalId, 'provider-transfer')
      return request()
    }
  })
  sdk.getBalance = async () => ({balance: 1000000n})
  sdk.getCachedBalance = sdk.getBalance
  sdk.leafManager = {
    selectLeavesAndExecute: async (_, callback) => callback([[]]),
    handleTransferEvent: async () => {}
  }
  sdk.transferService = {prepareTransferForLightning: async () => ({})}
  sdk.lightningService = {
    swapNodesForPreimage: async params => {
      keys.push(params.idempotencyKey)
      return {transfer: {id: 'provider-transfer'}}
    }
  }
  const options = {
    getWallet: async () => sdk,
    network: 'MAINNET',
    fundsWaitMs: 0
  }
  for (const bolt11 of [invoice, invoice.toUpperCase()]) {
    const service = new PaymentService(options)
    t.after(() => service.operations.close())
    assert.equal(
      (await service.lightning(paymentHash, {...data, bolt11})).status,
      'LIGHTNING_PAYMENT_SUCCEEDED'
    )
  }
  assert.equal(keys.length, 2)
  assert.match(keys[0], /^[0-9a-f]{64}$/)
  assert.equal(keys[0], keys[1])
})

test('new checking IDs are Spark IDs and survive replacement without sidecar state', async t => {
  let status = 'CREATED',
    sends = 0
  const {service, options} = setup(t, {
    payLightningInvoice: async () => {
      sends++
      return request(status)
    },
    getLightningSendRequest: async id => {
      assert.equal(id, 'spark-request')
      return request(status)
    }
  })
  const sent = await service.lightning(paymentHash, data)
  assert.equal(sent.checking_id, 'spark-request')
  assert.equal(sent.status, 'CREATED')
  const replacement = new PaymentService(options)
  status = 'LIGHTNING_PAYMENT_SUCCEEDED'
  const checked = await replacement.lightning(sent.checking_id)
  assert.equal(checked.status, status)
  assert.equal(checked.preimage, 'proof')
  assert.equal(checked.fee_msat, 2000)
  assert.equal(sends, 1)
  status = 'LIGHTNING_PAYMENT_FAILED'
  assert.equal(
    (await new PaymentService(options).lightning(sent.checking_id)).status,
    status
  )
})

test('Spark receives a stable idempotency key across restarts, casing and fee changes', async t => {
  const keys = new Set()
  let transfers = 0
  const {service, options} = setup(t, {
    // Simulate provider history lag: deduplication must not depend on local data.
    payLightningInvoice: async params => {
      assert.equal(params.preferSpark, false)
      assert.match(params.idempotencyKey, /^[0-9a-f]{64}$/)
      if (!keys.has(params.idempotencyKey)) {
        keys.add(params.idempotencyKey)
        transfers++
      }
      return request()
    }
  })
  await service.lightning(paymentHash, data)
  await new PaymentService(options).lightning(paymentHash, {
    ...data,
    bolt11: invoice.toUpperCase(),
    max_fee_sats: 20
  })
  assert.equal(transfers, 1)
})

test('an already paid invoice is recovered from Spark even with an empty balance', async t => {
  const {service} = setup(t, {
    getUserRequests: async () => page([request()]),
    getBalance: async () =>
      assert.fail('must not require funds to check a paid invoice'),
    payLightningInvoice: async () => assert.fail('must not resubmit')
  })
  assert.equal(
    (await service.lightning(paymentHash, data)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
})

test('lost send response recovers through Spark history after replacement', async t => {
  let visible = false,
    calls = 0
  const {service, options} = setup(t, {
    payLightningInvoice: async () => {
      calls++
      throw new Error('lost response')
    },
    getUserRequests: async () => page(visible ? [request()] : [])
  })
  assert.equal((await service.lightning(paymentHash, data)).status, 'UNKNOWN')
  visible = true
  assert.equal(
    (await new PaymentService(options).lightning(paymentHash)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  assert.equal(calls, 1)
})

test('unknown, absent and mismatched provider responses never settle or resend', async t => {
  for (const response of [
    null,
    request('CREATED'),
    request('LIGHTNING_PAYMENT_SUCCEEDED', 'wrong-id')
  ]) {
    const {service} = setup(t, {
      getLightningSendRequest: async () => response,
      payLightningInvoice: async () => assert.fail('GET cannot send')
    })
    assert(
      ['UNKNOWN', 'CREATED'].includes(
        (await service.lightning('spark-request')).status
      )
    )
  }
  const {service} = setup(t, {
    getLightningSendRequest: async () => {
      throw new Error('outage')
    }
  })
  assert.equal((await service.lightning('spark-request')).status, 'UNKNOWN')
})

test('old hash-based checking IDs never infer failure from an earlier attempt', async t => {
  for (const entities of [
    [request('LIGHTNING_PAYMENT_FAILED')],
    [request('LIGHTNING_PAYMENT_FAILED'), request('CREATED', 'second')],
    [request(), request('CREATED', 'second')]
  ]) {
    const {service} = setup(t, {getUserRequests: async () => page(entities)})
    assert.equal((await service.lightning(paymentHash)).status, 'UNKNOWN')
  }
})

test('submissions do not restart failed or ambiguous legacy attempts', async t => {
  for (const entities of [
    [request('LIGHTNING_PAYMENT_FAILED')],
    [request('LIGHTNING_PAYMENT_FAILED'), request('CREATED', 'second')],
    [request(), request('CREATED', 'second')]
  ]) {
    const {service} = setup(t, {
      getUserRequests: async () => page(entities),
      payLightningInvoice: async () =>
        assert.fail('must not start another attempt')
    })
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal(
        (await service.lightning(paymentHash, data)).status,
        'UNKNOWN'
      )
  }
})

test('long history scans are bounded per check and continue until the payment is found', async t => {
  const afters = []
  const {service} = setup(t, {
    getUserRequests: async ({after}) => {
      afters.push(after)
      if (!after) return page([], 'a')
      if (after === 'a') return page([], 'b')
      if (after === 'b') return page([], 'c')
      return page([request()])
    }
  })
  assert.equal((await service.lightning(paymentHash)).status, 'UNKNOWN')
  assert.equal(afters.length, 2)
  assert.equal(
    (await service.lightning(paymentHash)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  assert.deepEqual(afters, [undefined, 'a', 'b', 'c'])
})

test('malformed history never proves success', async t => {
  for (const providerPage of [
    null,
    {},
    {entities: []},
    page([request()], 'repeat')
  ]) {
    const {service} = setup(t, {getUserRequests: async () => providerPage})
    assert.equal((await service.lightning(paymentHash)).status, 'UNKNOWN')
  }
})

for (const [method, code] of [
  ['getLightningSendFeeEstimate', 'FEE_QUOTE_UNAVAILABLE'],
  ['getBalance', 'BALANCE_UNAVAILABLE']
]) {
  test(`safe ${code} diagnostics do not expose SDK exceptions`, async t => {
    const logs = [],
      secret = 'MOCK_MNEMONIC_MUST_NOT_LEAK'
    t.mock.method(console, 'warn', value => logs.push(value))
    const {service} = setup(t, {
      [method]: async () => {
        throw new Error(secret)
      },
      payLightningInvoice: async () => assert.fail('must not send')
    })
    const result = await service.lightning(paymentHash, data)
    assert.equal(result.status, 'LIGHTNING_PAYMENT_FAILED')
    assert.equal(result.failure_code, code)
    assert(!JSON.stringify([result, logs]).includes(secret))
  })
}

test('fee allowance is enforced and its safe diagnostic includes both amounts', async t => {
  const {service} = setup(t, {
    getLightningSendFeeEstimate: async () => 11,
    payLightningInvoice: async () => assert.fail('must not send')
  })
  const result = await service.lightning(paymentHash, data)
  assert.equal(result.status, 'LIGHTNING_PAYMENT_FAILED')
  assert.equal(result.failure_code, 'FEE_LIMIT_EXCEEDED')
  assert.equal(
    result.error_message,
    'Spark fee quote (11 sats) exceeds the payment fee limit (10 sats)'
  )
})

test('funds can clear within the original send request', async t => {
  let reads = 0,
    sends = 0
  const {service} = setup(
    t,
    {
      getBalance: async () => ({balance: ++reads === 1 ? 0n : 1000000n}),
      payLightningInvoice: async () => {
        sends++
        return request()
      }
    },
    {fundsWaitMs: 15}
  )
  assert.equal(
    (await service.lightning(paymentHash, data)).status,
    'LIGHTNING_PAYMENT_SUCCEEDED'
  )
  assert.equal(sends, 1)
})

test('unavailable funds are not queued and later status checks never dispatch', async t => {
  let available = 0n
  const {service, options} = setup(
    t,
    {
      getBalance: async () => ({
        balance: available,
        satsBalance: {available, owned: 1000000n, incoming: 0n}
      }),
      payLightningInvoice: async () => assert.fail('no background/GET dispatch')
    },
    {fundsWaitMs: 10}
  )
  const failed = await service.lightning(paymentHash, data)
  assert.equal(failed.status, 'LIGHTNING_PAYMENT_FAILED')
  assert.equal(failed.failure_code, 'FUNDS_UNAVAILABLE')
  available = 1000000n
  assert.equal(
    (await new PaymentService(options).lightning(paymentHash)).status,
    'UNKNOWN'
  )
})

test('disconnecting before dispatch cancels a funds wait', async t => {
  const abort = new AbortController()
  const {service} = setup(
    t,
    {
      getBalance: async () => {
        abort.abort()
        return {balance: 0n}
      },
      payLightningInvoice: async () =>
        assert.fail('must not dispatch after cancellation')
    },
    {fundsWaitMs: 100}
  )
  assert.equal(
    (await service.lightning(paymentHash, data, abort.signal)).status,
    'LIGHTNING_PAYMENT_FAILED'
  )
})

test('only known pre-dispatch SDK validation errors are explicit failures', async () => {
  const safe = new SparkValidationError(
    'maxFeeSats does not cover fee estimate'
  )
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
    ).not_sent,
    true
  )
  const ambiguous = new SparkValidationError('Invalid SSP response after send')
  await assert.rejects(
    sendLightningPayment(
      {
        payLightningInvoice: async () => {
          throw ambiguous
        }
      },
      {}
    )
  )
})

for (const [unit, value, expected] of [
  ['MILLISATOSHI', 1234, 1234],
  ['SATOSHI', '1.234', 1234],
  ['BITCOIN', '0.00000001234', 1234]
]) {
  test(`provider ${unit} fee is converted exactly`, async t => {
    const {service} = setup(t, {
      getLightningSendRequest: async () => ({
        ...request(),
        fee: {originalUnit: unit, originalValue: value}
      })
    })
    assert.equal((await service.lightning('spark-request')).fee_msat, expected)
  })
}

async function http(handler, method, url, payload, apiKey = 'test') {
  const req = Readable.from(
    payload ? [Buffer.from(JSON.stringify(payload))] : []
  )
  req.method = method
  req.headers = {'x-api-key': apiKey}
  let status, result
  await handler(
    req,
    {
      writeHead: code => {
        status = code
      },
      end: text => {
        result = JSON.parse(text)
      }
    },
    new URL(url, 'http://localhost')
  )
  return {status, result}
}

test('HTTP compatibility covers authentication, invoice hashes and opaque Spark IDs', async t => {
  const {options} = setup(t, {
    getLightningSendRequest: async id =>
      request('LIGHTNING_PAYMENT_SUCCEEDED', id)
  })
  const handler = await createPaymentHandler({...options, apiKey: 'test'})
  t.after(() => handler.close())
  assert.equal(
    (await http(handler, 'POST', '/v1/payments', data, 'wrong')).status,
    401
  )
  assert.equal(
    (
      await http(handler, 'POST', '/v1/payments', {
        ...data,
        payment_hash: '0'.repeat(64)
      })
    ).status,
    409
  )
  const sent = await http(handler, 'POST', '/v1/payments', data)
  assert.equal(sent.result.checking_id, 'spark-request')
  const checked = await http(
    handler,
    'GET',
    '/v1/payments/Spark%3Aopaque%2F%3D'
  )
  assert.equal(checked.result.checking_id, 'Spark:opaque/=')
  assert.equal(checked.result.status, 'LIGHTNING_PAYMENT_SUCCEEDED')
})

test('concurrent invoices and duplicate POSTs stay separate with provider deduplication', async t => {
  const sent = new Map(),
    activeHashes = new Set()
  let peak = 0
  const {options} = setup(t, {
    payLightningInvoice: async params => {
      const hash = decodePayment(params.invoice).hash
      assert(!activeHashes.has(hash))
      activeHashes.add(hash)
      peak = Math.max(peak, activeHashes.size)
      await new Promise(resolve => setTimeout(resolve, 5))
      activeHashes.delete(hash)
      if (!sent.has(params.idempotencyKey))
        sent.set(params.idempotencyKey, {
          ...request(),
          id: `spark-${hash}`,
          invoice: {paymentHash: hash}
        })
      return sent.get(params.idempotencyKey)
    }
  })
  const handler = await createPaymentHandler({...options, apiKey: 'test'})
  t.after(() => handler.close())
  const encoded = bech32.decode(invoice, 5000)
  const invoices = Array.from({length: 100}, (_, i) => {
    const words = [...encoded.words]
    words.splice(
      10,
      52,
      ...bech32.toWords(Buffer.from(i.toString(16).padStart(64, '0'), 'hex'))
    )
    return bech32.encode(encoded.prefix, words, 5000)
  })
  const results = await Promise.all(
    [...invoices, ...invoices].map(async bolt11 => {
      const result = await http(handler, 'POST', '/v1/payments', {
        ...data,
        bolt11
      })
      const hash = decodePayment(bolt11).hash
      assert.equal(result.result.checking_id, `spark-${hash}`)
      assert.equal(result.result.payment_hash, hash)
      return result
    })
  )
  assert.equal(results.length, 200)
  assert.equal(sent.size, 100)
  assert.equal(peak, 8)
})
