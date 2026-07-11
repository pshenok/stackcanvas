import { expect, test } from 'vitest'
import { VERSION } from './index.js'

test('workspace wiring works', () => {
  expect(VERSION).toBe('0.1.0')
})
