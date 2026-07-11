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
