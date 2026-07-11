import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { applyPlan } from './apply-plan.js'
import { parseState } from './parse-state.js'
import { summarizeGraph } from './summarize.js'

const load = (f: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8'))

test('summarizes counts and plan changes', () => {
  const text = summarizeGraph(applyPlan(parseState(load('state.json')), load('plan.json')))
  expect(text).toContain('5 resources')
  expect(text).toContain('aws_instance: 1')
  expect(text).toContain('update: aws_instance.web')
  expect(text).toContain('replace: aws_subnet.a')
  expect(text).toContain('create: aws_s3_bucket.assets')
})

test('no plan changes reported when everything is noop', () => {
  const text = summarizeGraph(parseState(load('state.json')))
  expect(text).toContain('No pending plan changes')
})
