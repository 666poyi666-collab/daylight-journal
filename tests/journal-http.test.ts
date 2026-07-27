import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedNativeJournalUrl } from '../src/journal/http.ts'

test('native Journal HTTP only permits HTTPS or fixed private service ports', () => {
  assert.equal(isAllowedNativeJournalUrl('https://sync.example.com/journal/all'), true)
  assert.equal(isAllowedNativeJournalUrl('http://192.168.50.20:8781/journal/all'), true)
  assert.equal(isAllowedNativeJournalUrl('http://journal-host.local:8781/journal/all'), true)
  assert.equal(isAllowedNativeJournalUrl('http://127.0.0.1:8780/journal/all'), true)
  assert.equal(isAllowedNativeJournalUrl('http://192.168.50.20:3000/journal/all'), false)
  assert.equal(isAllowedNativeJournalUrl('http://example.com:8781/journal/all'), false)
  assert.equal(isAllowedNativeJournalUrl('file:///journal/all'), false)
})
