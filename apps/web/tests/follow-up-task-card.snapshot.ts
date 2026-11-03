import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  fixtureUserPrompts,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { FOLLOW_UP_TASK_FIXTURE } from './follow-up-task-fixture.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/follow-up-task-card', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v4.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const CARD = '[data-follow-up-task-card="follow-up-task-call"]'

describe('follow-up task card', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let browser: Browser | undefined
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined

  beforeAll(async () => {
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    if (prompt === undefined) throw new Error('the follow-up task fixture records no user prompt')
    scaffold = await launchWebScaffold({
      ...FOLLOW_UP_TASK_FIXTURE,
      replayFixture: FIXTURE,
      compareReplaySession: true,
      paceMs: 10,
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('follow-up-task-card-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'standard' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    agentHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await agentHandle.agent.whenIdle()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await page?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'follow-up task card teardown failed')
  })

  it.skipIf(MODE === 'record')('renders the available card and its keyed transcript row', async () => {
    onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'web-follow-up-task-card') })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText('README_TYPO_FIXED', { exact: true }).waitFor({ timeout: 15_000 })

    const card = page.locator(CARD)
    await card.waitFor({ timeout: 15_000 })
    await expect.poll(() => card.getAttribute('data-state')).toBe('available')
    await card.getByText('Follow-up task', { exact: true }).waitFor()
    await card.getByText('Add a test for the README example', { exact: true }).waitFor()
    await card.getByText(
      'The README quick-start walkthrough has no automated coverage. This task adds a test that runs the documented commands and checks their output.',
      { exact: true },
    ).waitFor()
    await card.getByRole('button', { name: 'Start follow-up task: Add a test for the README example', exact: true }).waitFor()
    await card.getByRole('button', { name: 'Dismiss', exact: true }).waitFor()
    await card.getByRole('button', { name: 'Show prompt', exact: true }).waitFor()

    const row = page.locator('[data-tool="suggest_follow_up_task"]')
    await expandOwningTurnProcess(page, row)
    await row.waitFor({ timeout: 15_000 })
    const rowTitle = row.getByRole('button', { name: 'Suggest follow-up task Add a test for the README example', exact: true })
      .first()
    await rowTitle.waitFor({ timeout: 15_000 })
    expect(await rowTitle.getAttribute('aria-expanded')).toBe('false')

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v4.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
      'ui.expected.md',
    ])
  })
})
