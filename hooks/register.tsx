import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Snap } from '../types'

const snap = atom({ plugin: 'session-meter', key: 'snap' } as const, null)
const cache = atom({ plugin: 'session-meter', key: 'cache' } as const, {
  steps: 0,
  read: 0,
  written: 0,
  uncached: 0,
  lastHit: null,
})
const isCollapsed = atom({ plugin: 'session-meter', key: 'isCollapsed' } as const, false)

const LIMIT_NAMES: Record<string, string> = { five_hour: '5ч', seven_day: '7д', spend_limit: 'лимит' }

async function refresh($: EngineInterface) {
  try {
    // `summary` estimates locally (no API calls); its rawMaxTokens is the
    // effective window: autoCompactWindow / env override, else the model's.
    const u = await $.session.usage({ breakdown: 'summary', columns: 40 })
    const tokens = u.context.tokens ?? 0
    const window = u.context.breakdown?.rawMaxTokens || u.context.window
    const s: Snap = {
      at: await $.clock.now(),
      contextTokens: tokens,
      contextWindow: window,
      modelWindow: u.context.window,
      contextPercent: window ? Math.min(100, (tokens / window) * 100) : 0,
      usd: u.cost?.usd,
      limits: u.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })),
    }
    await update($, snap, () => s)
  } catch {
    // Keep the last snapshot; the next step or tick retries.
  }
}

export function sessionHit(c: Cache): number | null {
  const total = c.read + c.written + c.uncached
  return total ? (c.read / total) * 100 : null
}

const pct = (p: number | null) => (p === null ? '—' : `${Math.round(p)}%`)
const tok = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n)
const bar = (p: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((p / 100) * width)))
  return '█'.repeat(full) + '░'.repeat(width - full)
}
const loadColor = (p: number) => (p < 60 ? 'success' : p < 85 ? 'warning' : 'error')
const cacheColor = (p: number | null) =>
  p === null ? 'inactive' : p >= 80 ? 'success' : p >= 50 ? 'warning' : 'error'

function resetsIn(resetsAt: string | undefined, now: number) {
  const ms = resetsAt ? Date.parse(resetsAt) - now : NaN
  if (!(ms > 0)) return ''
  const m = Math.round(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `сброс через ${d}д ${h}ч` : h ? `сброс через ${h}ч ${m % 60}м` : `сброс через ${m}м`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // Redraws the reset countdowns and picks up compaction between turns.
    $.clock.every(60_000, () => void refresh($))
    return result
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    // ponytail: main thread only; subagents keep caches of their own.
    if (u && e.agentId === undefined) {
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, cache, c => ({
        steps: c.steps + 1,
        read: c.read + u.cache_read_input_tokens,
        written: c.written + u.cache_creation_input_tokens,
        uncached: c.uncached + u.input_tokens,
        lastHit: total ? (u.cache_read_input_tokens / total) * 100 : c.lastHit,
      }))
      await refresh($)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const s = await read($, snap)
    const c = await read($, cache)
    const collapsed = await read($, isCollapsed)
    const hit = sessionHit(c)
    const toggle = () => update($, isCollapsed, v => !v)
    const { Box, Text, Button } = $.ui.resolve(e)

    if (collapsed) {
      const firstLimit = s?.limits[0]
      return (
        <Box flexDirection="row">
          <Button key="toggle" label="▸" plain dimColor onPress={toggle} />
          <Text dimColor> ctx </Text>
          <Text color={loadColor(s?.contextPercent ?? 0)}>{pct(s?.contextPercent ?? null)}</Text>
          <Text dimColor> · cache </Text>
          <Text color={cacheColor(c.lastHit)}>{pct(c.lastHit)}</Text>
          <Text dimColor>{s?.usd === undefined ? '' : ` · $${s.usd.toFixed(2)}`}</Text>
          <Text dimColor>
            {firstLimit ? ` · ${LIMIT_NAMES[firstLimit.kind] ?? firstLimit.kind} ${pct(firstLimit.percent)}` : ''}
          </Text>
        </Box>
      )
    }

    const width = e.props.bodyColumns >= 64 ? 14 : 8
    const row = (label: string, p: number | null, color: string, detail: string) => (
      <Box flexDirection="row">
        <Box width={10}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text color={color}>{bar(p ?? 0, width)}</Text>
        <Box width={6} justifyContent="flex-end">
          <Text color={color} bold>{pct(p)}</Text>
        </Box>
        <Text dimColor wrap="truncate">{'  ' + detail}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Сессия</Text>
          <Button key="toggle" label="▾ свернуть" plain dimColor onPress={toggle} />
        </Box>
        {s
          ? row(
              'Контекст',
              s.contextPercent,
              loadColor(s.contextPercent),
              `${tok(s.contextTokens)} / ${tok(s.contextWindow)}` +
                (s.contextWindow < s.modelWindow ? ` · модель ${tok(s.modelWindow)}` : ''),
            )
          : <Text dimColor>Жду первые данные…</Text>}
        {row(
          'Кеш',
          c.lastHit,
          cacheColor(c.lastHit),
          c.steps
            ? `за сессию ${pct(hit)} · ${tok(c.read)} из ${tok(c.read + c.written + c.uncached)} · ${c.steps} запр.`
            : 'ещё не было запросов',
        )}
        {(s?.limits ?? []).map(l =>
          row(LIMIT_NAMES[l.kind] ?? l.kind, l.percent, loadColor(l.percent), resetsIn(l.resetsAt, s!.at)),
        )}
        {s?.usd === undefined ? null : (
          <Box flexDirection="row">
            <Box width={10}>
              <Text dimColor>Расход</Text>
            </Box>
            <Text bold>{`$${s.usd.toFixed(2)}`}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
