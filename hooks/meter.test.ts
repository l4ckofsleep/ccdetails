import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

test('cache hit % from main-thread steps, band toggles', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-12T10:00:00Z') })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        tokens: 128_000,
        window: 1_000_000,
        percent: 13,
        breakdown: {
          categories: [], totalTokens: 128_000, maxTokens: 512_000, rawMaxTokens: 512_000,
          autocompactSource: 'settings' as const, percentage: 25, gridRows: [], model: 'm',
          memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
        },
      },
      rateLimits: [{ kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-12T12:10:00Z' }],
      cost: { usd: 1.5 },
    },
  }))
  const reads = [900, 0]
  on('turn.step', async function* (_$, e) {
    const read = e.agentId ? 1000 : (reads[e.index] ?? 0)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: 'm', input_tokens: 100, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: 900 - read },
    }
  })

  const step = async (index: number, agentId?: string) => {
    const s = $.turn.step({ turnId: 't', index, model: 'm', messageCount: 1, agentId })
    for await (const _ of s);
  }
  await step(0) // 900 / 1000 = 90%
  await step(1) // last 0%, session 900 / 2000 = 45%
  await step(0, 'sub') // ignored

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-meter', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /за сессию 45% · 900 из 2k · 2 запр\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.50' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /128k \/ 512k · модель 1M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /сброс через 2ч 10м/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: ' · cache ' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})
