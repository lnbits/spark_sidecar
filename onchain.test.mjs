import assert from 'node:assert/strict'
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {OnchainJournal, OnchainService} from './onchain.mjs'

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

async function setup(t, wallet) {
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
      network: 'REGTEST'
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

test('deposit address is unique per id and pending leaves never mean available', async t => {
  let addresses = 0
  let claims = 0
  let available = false
  const wallet = {
    getSingleUseDepositAddress: async () => `address-${++addresses}`,
    claimDeposit: async () => {
      claims++
      return [
        {id: 'leaf', status: 'CREATING', value: 10000, nodeTx: 'transaction'}
      ]
    },
    getLeaves: async () =>
      available ? [{id: 'leaf', status: 'AVAILABLE'}] : []
  }
  const {service} = await setup(t, wallet)
  assert.equal(
    (await service.address('swap-one')).address,
    (await service.address('swap-one')).address
  )
  assert.notEqual(
    (await service.address('swap-one')).address,
    (await service.address('swap-two')).address
  )
  const data = {txid: 'a'.repeat(64), vout: 0, amount_sats: 10000}
  assert.equal((await service.claim('swap-one', data)).available, false)
  available = true
  assert.equal((await service.claim('swap-one', data)).available, true)
  assert.equal(claims, 1)
  await assert.rejects(service.claim('swap-one', {...data, vout: 1}))
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
  const hash = 'a'.repeat(64)
  const data = {bolt11: 'invoice', max_fee_sats: 10}
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
  const hash = 'a'.repeat(64)
  const data = {bolt11: 'invoice', max_fee_sats: 10}
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
        await service.lightning('a'.repeat(64), {
          bolt11: 'invoice',
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
