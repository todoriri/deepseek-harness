/**
 * The timing prompt section follows the suggest tool: it renders where the tool
 * is visible, at its allocated order, and leaves with the plugin fiber.
 */

import { describe, expect, it } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { SUGGEST_TOOL_NAME, harness } from './harness.ts'
import type { Bench } from './harness.ts'

const SECTION_NAME = 'tool:follow-up-task'
const SECTION_TEXT = 'Before your final response, if you noticed worthwhile work outside this request, offer it with suggest_follow_up_task instead of only listing it in your reply.'

/** Boot the bench with the native executor that prompt assembly asks to describe tools. */
async function assemblyBench(): Promise<Bench> {
  const bench = await harness()
  await bench.ctx.plugin(NativeToolExecutor)
  return bench
}

describe('follow-up task prompt section', () => {
  it('renders the timing section between its neighbouring order slots', async () => {
    const bench = await assemblyBench()
    const { systemPrompt } = bench.ctx
    systemPrompt.section({ name: 'probe:before', order: systemPrompt.getSectionOrder('TOOL_REPORT'), text: 'BEFORE' })
    systemPrompt.section({ name: 'probe:after', order: systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text: 'AFTER' })
    const names = (await systemPrompt.assemble({ scope: bench.agent })).sections.map(section => section.name)
    expect(names.slice(names.indexOf('probe:before'))).toEqual(['probe:before', SECTION_NAME, 'probe:after', ...names.slice(names.indexOf('probe:after') + 1)])
    expect(renderPrompt(await systemPrompt.assemble({ scope: bench.agent }))).toContain(`BEFORE\n\n${SECTION_TEXT}\n\nAFTER`)
  })

  it('renders nothing in a scope where the suggest tool is hidden', async () => {
    const bench = await assemblyBench()
    const release = bench.agent.ctx.tools.restrict({ deny: [SUGGEST_TOOL_NAME] })
    expect(renderPrompt(await bench.ctx.systemPrompt.assemble({ scope: bench.agent }))).not.toContain(SECTION_TEXT)
    release()
    expect(renderPrompt(await bench.ctx.systemPrompt.assemble({ scope: bench.agent }))).toContain(SECTION_TEXT)
  })

  it('removes the section when the plugin fiber unloads', async () => {
    const bench = await assemblyBench()
    await bench.fiber.dispose()
    const assembly = await bench.ctx.systemPrompt.assemble({ scope: bench.agent })
    expect(assembly.sections.map(section => section.name)).not.toContain(SECTION_NAME)
  })
})
