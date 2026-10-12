export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Snap = {
  at: number
  contextTokens: number
  // Effective window (compaction limit when set); modelWindow is the model's own.
  contextWindow: number
  modelWindow: number
  contextPercent: number
  usd?: number
  limits: Limit[]
}

// Main-thread prompt-cache counters, in input tokens.
export type Cache = {
  steps: number
  read: number
  written: number
  uncached: number
  lastHit: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-meter': { snap: Snap | null; cache: Cache; isCollapsed: boolean }
  }
}
