import { beforeEach, expect, test } from 'vitest'
import { useStore } from './store.js'

beforeEach(() => {
  useStore.getState().clearDrafts()
})

test('requestModify clears the address from removes', () => {
  useStore.getState().toggleRemove('aws_instance.web')
  expect(useStore.getState().removes.has('aws_instance.web')).toBe(true)

  useStore.getState().requestModify('aws_instance.web', 'bump root volume')
  const state = useStore.getState()
  expect(state.removes.has('aws_instance.web')).toBe(false)
  expect(state.modifies['aws_instance.web']).toBe('bump root volume')
})

test('toggleRemove clears modifies', () => {
  useStore.getState().requestModify('aws_instance.web', 'bump root volume')
  expect(useStore.getState().modifies['aws_instance.web']).toBe('bump root volume')

  useStore.getState().toggleRemove('aws_instance.web')
  const state = useStore.getState()
  expect(state.removes.has('aws_instance.web')).toBe(true)
  expect(state.modifies['aws_instance.web']).toBeUndefined()
})

test('addDraftEdge dedups identical source/target pairs', () => {
  useStore.getState().addDraftEdge('aws_vpc.main', 'draft-1')
  useStore.getState().addDraftEdge('aws_vpc.main', 'draft-1')
  expect(useStore.getState().draftEdges).toEqual([{ source: 'aws_vpc.main', target: 'draft-1' }])

  useStore.getState().addDraftEdge('draft-1', 'aws_vpc.main')
  expect(useStore.getState().draftEdges).toEqual([
    { source: 'aws_vpc.main', target: 'draft-1' },
    { source: 'draft-1', target: 'aws_vpc.main' },
  ])
})
