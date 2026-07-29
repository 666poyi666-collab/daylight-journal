import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReviewPrompt } from '../src/journal/review.ts'

test('review prompt requests deep evidence-based and longitudinal analysis', () => {
  const prompt = buildReviewPrompt('2026-07-22')

  assert.match(prompt, /journal_get_entry/)
  assert.match(prompt, /journal_list_recent/)
  assert.match(prompt, /journal:\/\/entries/)
  assert.match(prompt, /journal:\/\/entries\/2026-07-22/)
  assert.equal(prompt.includes('journal://entries/{date}'), false)
  assert.match(prompt, /长期模式/)
  assert.match(prompt, /长期记忆更新候选/)
  assert.match(prompt, /不要声称已经写入永久记忆/)
  assert.match(prompt, /2026-07-22/)
})
