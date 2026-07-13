import { expect, test } from '@playwright/test'

test('consent banner: visible on fresh state, dismissed by "No thanks", stays dismissed after reload', async ({ page }) => {
  await page.goto('/')
  const banner = page.getByRole('dialog', { name: 'Telemetry consent' })
  await expect(banner).toBeVisible()

  const posted = page.waitForRequest(r => r.url().includes('/api/telemetry') && r.method() === 'POST')
  await page.getByRole('button', { name: 'No thanks' }).click()
  const req = await posted
  expect(req.postDataJSON()).toEqual({ granted: false })
  await expect(banner).toBeHidden()

  await page.reload()
  await expect(page.getByRole('dialog', { name: 'Telemetry consent' })).toBeHidden()
})
