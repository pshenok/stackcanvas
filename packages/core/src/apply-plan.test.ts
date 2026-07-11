import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseState } from './parse-state.js'
import { applyPlan } from './apply-plan.js'

const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8'))

const graph = () => applyPlan(parseState(load('state.json')), load('plan.json'))

test('statuses map from actions', () => {
  const g = graph()
  const status = (id: string) => g.nodes.find(n => n.id === id)?.status
  expect(status('aws_instance.web')).toBe('update')
  expect(status('aws_subnet.a')).toBe('replace')
  expect(status('module.data.aws_db_instance.db')).toBe('delete')
  expect(status('aws_vpc.main')).toBe('noop')
})

test('create adds a new node with after-attributes', () => {
  const g = graph()
  const bucket = g.nodes.find(n => n.id === 'aws_s3_bucket.assets')
  expect(bucket?.status).toBe('create')
  expect(bucket?.attributes['bucket']).toBe('my-assets')
  expect(bucket?.provider).toBe('aws')
})

test('sensitive create attributes are masked', () => {
  const g = graph()
  const bucket = g.nodes.find(n => n.id === 'aws_s3_bucket.assets')!
  expect(bucket.attributes['secret_token']).toBe('•••')
  expect(bucket.attributeDiff).toContainEqual({ key: 'secret_token', before: null, after: '•••' })
})

test('attributeDiff lists changed keys only, masking sensitive values', () => {
  const g = graph()
  const web = g.nodes.find(n => n.id === 'aws_instance.web')!
  expect(web.attributeDiff).toEqual([
    { key: 'admin_password', before: '•••', after: '•••' },
    { key: 'instance_type', before: 't3.micro', after: 't3.large' },
  ])
})

test('garbage plan input leaves graph unchanged', () => {
  const base = parseState(load('state.json'))
  expect(applyPlan(base, null).nodes.length).toBe(base.nodes.length)
})
