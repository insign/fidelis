import type { Config, Host } from "./types.ts"

export const HOST_DEFAULTS: Record<Host, { compilerModel: string; compilerEffort: string; judgeModel: string; judgeEffort: string }> = {
  opencode: { compilerModel: "opencode/big-pickle", compilerEffort: "default", judgeModel: "opencode/jev-1.13-free", judgeEffort: "default" },
  "claude-code": { compilerModel: "claude-haiku-5-5", compilerEffort: "xhigh", judgeModel: "claude-haiku-5-5", judgeEffort: "xhigh" },
}

/** Default models whose free tier may use submitted data for training. Needs explicit consent. */
export const DATA_USE_MODELS = new Set(["opencode/big-pickle"])

const BASE = {
  enabled: true,
  compilerPromptPath: null,
  judgePromptPath: null,
  auditOnCompletion: true,
  maxCorrections: 3,
  minViolationConfidence: 0.9,
  maxAuditTokens: 12000,
  maxAuditCostUSD: null,
  cacheChecklist: true,
  storeRawTranscript: false,
  allowFreeModelDataUse: false,
  trustSdkPrompts: false,
  timeoutMs: 240_000,
  retries: 1,
  auditDeadlineMs: 600_000,
  retentionDays: 30,
}

const UI: Config["ui"] = { enabled: true, footer: true, notifications: "important", auditPanel: true, plainTextIcons: false }

export function resolveConfig(host: Host, options: Record<string, unknown> = {}): Config {
  const merged: any = { ...BASE, ...HOST_DEFAULTS[host] }
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === "auto" || key === "ui" || !(key in merged)) continue
    const expected = BASE[key as keyof typeof BASE]
    if (expected !== null && expected !== undefined && typeof value !== typeof expected) throw new Error(`fidelis: option ${key} must be ${typeof expected}`)
    merged[key] = value
  }
  merged.ui = { ...UI, ...(options.ui as object | undefined) }
  return merged
}

/** Consent is implied only when the user named the model; the built-in default must be opted in. */
export function consentProblem(model: string, options: Record<string, unknown>, config: Config): string | null {
  const named = Object.values(options).includes(model)
  if (!DATA_USE_MODELS.has(model) || named || config.allowFreeModelDataUse) return null
  return `Default model ${model} may use submitted data for training during its free period. Set allowFreeModelDataUse: true or configure another model.`
}
