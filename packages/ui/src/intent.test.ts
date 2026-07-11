import { expect, test } from 'vitest'
import { buildIntent, buildPrompt } from './intent.js'

const state = {
  drafts: [{ id: 'draft-1', type: 'aws_db_instance', name: 'app_db', wishes: 'small instance' }],
  draftEdges: [
    { source: 'aws_vpc.main', target: 'draft-1' },
    { source: 'draft-1', target: 'draft-1' },
  ],
  modifies: { 'aws_instance.web': 'bump root volume to 50gb' },
  removes: new Set(['aws_s3_bucket.legacy']),
}

test('buildIntent maps drafts, connections, modifies, removes', () => {
  const intent = buildIntent(state)
  expect(intent).toEqual({
    add: [{ type: 'aws_db_instance', name: 'app_db', wishes: 'small instance',
            connect_to: ['aws_vpc.main'] }],
    modify: [{ address: 'aws_instance.web', wishes: 'bump root volume to 50gb' }],
    remove: [{ address: 'aws_s3_bucket.legacy' }],
  })
})

test('buildPrompt renders human-readable instructions', () => {
  const text = buildPrompt(buildIntent(state))
  expect(text).toContain('ADD aws_db_instance')
  expect(text).toContain('connected to: aws_vpc.main')
  expect(text).toContain('MODIFY aws_instance.web')
  expect(text).toContain('REMOVE aws_s3_bucket.legacy')
  expect(text).toContain('.stackcanvas/plan.json')
})
