import { expect, test } from '@playwright/test'

test('renders the fixture graph', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('aws_instance', { exact: true })).toBeVisible()
  await expect(page.getByText('web', { exact: true })).toBeVisible()
})

test('palette click creates a dashed draft and Apply posts the intent', async ({ page }) => {
  await page.goto('/')
  const posted = page.waitForRequest(r => r.url().includes('/api/intent') && r.method() === 'POST')
  await page.getByRole('button', { name: 'RDS instance' }).click()
  await expect(page.locator('.resource-node.draft')).toBeVisible()
  await page.getByRole('button', { name: /^Apply/ }).click()
  const req = await posted
  const body = req.postDataJSON() as { add: { type: string }[] }
  expect(body.add[0].type).toBe('aws_db_instance')
  await expect(page.locator('.resource-node.draft')).toHaveCount(0)
})

test('context menu marks a node for removal', async ({ page }) => {
  await page.goto('/')
  await page.getByText('web', { exact: true }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Mark for removal' }).click()
  await expect(page.locator('.resource-node.removed')).toBeVisible()
})

test('nodes can be dragged', async ({ page }) => {
  await page.goto('/')
  const node = page.locator('.react-flow__node', { hasText: 'web' })
  await expect(node).toBeVisible()
  const before = (await node.boundingBox())!
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 150, before.y + before.height / 2 + 120, { steps: 8 })
  await page.mouse.up()
  const after = (await node.boundingBox())!
  const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y)
  expect(moved).toBeGreaterThan(50)
})

test('connecting two existing nodes draws a draft edge and Apply sends a modify', async ({ page }) => {
  await page.goto('/')
  const source = page.locator('.react-flow__node', { hasText: 'db' })
    .locator('.react-flow__handle.source')
  const target = page.locator('.react-flow__node', { hasText: 'web' })
    .locator('.react-flow__handle.target')
  await expect(source).toBeAttached()
  const sBox = (await source.boundingBox())!
  const tBox = (await target.boundingBox())!
  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(tBox.x + tBox.width / 2, tBox.y + tBox.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.locator('.react-flow__edge.animated')).toHaveCount(1)
  const posted = page.waitForRequest(r => r.url().includes('/api/intent') && r.method() === 'POST')
  await page.getByRole('button', { name: /^Apply/ }).click()
  const body = (await posted).postDataJSON() as { modify: { address: string; wishes: string }[] }
  expect(body.modify[0].address).toBe('aws_instance.web')
  expect(body.modify[0].wishes).toContain('module.data.aws_db_instance.db')
})
