import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLockRecord,
  decodeLockRecord,
  isPinFormat,
  verifyPin,
} from '../src/journal/lock.ts'

test('PIN format accepts only 4-6 digit strings', () => {
  assert.equal(isPinFormat('2468'), true)
  assert.equal(isPinFormat('135790'), true)
  assert.equal(isPinFormat('123'), false)
  assert.equal(isPinFormat('1234567'), false)
  assert.equal(isPinFormat('12a4'), false)
  assert.equal(isPinFormat(''), false)
})

test('lock record round-trips and rejects wrong PINs', async () => {
  const record = await createLockRecord('2468')
  assert.equal(record.length, 4)
  assert.equal(await verifyPin(record, '2468'), true)
  assert.equal(await verifyPin(record, '8642'), false)
  assert.equal(await verifyPin(record, '24680'), false)
  assert.equal(await verifyPin(record, ''), false)
})

test('two records for the same PIN use different salts and hashes', async () => {
  const first = await createLockRecord('7777')
  const second = await createLockRecord('7777')
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
  assert.equal(await verifyPin(second, '7777'), true)
})

test('tampered records fail verification instead of throwing', async () => {
  const record = await createLockRecord('2468')
  const tampered = { ...record, salt: 'not-base64!!' }
  assert.equal(await verifyPin(tampered, '2468'), false)
})

test('decodeLockRecord rejects malformed persisted values', async () => {
  const record = await createLockRecord('2468')
  const restored = decodeLockRecord(JSON.stringify(record))
  assert.deepEqual(restored, record)
  assert.equal(decodeLockRecord(null), null)
  assert.equal(decodeLockRecord('not json'), null)
  assert.equal(decodeLockRecord(JSON.stringify({ v: 2 })), null)
  assert.equal(
    decodeLockRecord(JSON.stringify({ ...record, iterations: 1 })),
    null,
  )
  assert.equal(decodeLockRecord(JSON.stringify({ ...record, length: 9 })), null)
})
