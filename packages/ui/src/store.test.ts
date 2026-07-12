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

test('removeDraft removes the draft, its edges, and deselects it', () => {
  useStore.getState().addDraft('aws_instance')
  const draft = useStore.getState().drafts[0]
  useStore.getState().addDraftEdge('aws_vpc.main', draft.id)
  useStore.getState().addDraftEdge(draft.id, 'aws_subnet.a')
  useStore.getState().select(draft.id)

  useStore.getState().removeDraft(draft.id)
  const state = useStore.getState()
  expect(state.drafts.some(d => d.id === draft.id)).toBe(false)
  expect(state.draftEdges.some(e => e.source === draft.id || e.target === draft.id)).toBe(false)
  expect(state.selected).toBeNull()
})

test('addDraftEdge rejects self-loops', () => {
  useStore.getState().addDraftEdge('aws_vpc.main', 'aws_vpc.main')
  expect(useStore.getState().draftEdges).toEqual([])
})

test('draft ids are never reused after delete or clear', () => {
  useStore.getState().addDraft('aws_instance')
  const first = useStore.getState().drafts[0].id
  useStore.getState().removeDraft(first)
  useStore.getState().addDraft('aws_instance')
  const second = useStore.getState().drafts[0].id
  expect(second).not.toBe(first)
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
