import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import type { AuditRecord, Checklist, ExecEvent, Host, SessionState } from "./types.ts"

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** Unambiguous encoding: every value carries its type and byte length. */
export function canonical(value: unknown): string {
  if (typeof value === "string") return `s${Buffer.byteLength(value)}:${value}`
  if (Array.isArray(value)) return `a${value.length}:${value.map(canonical).join("")}`
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => (value as any)[key] !== undefined).sort()
    return `o${keys.length}:${keys.map((key) => canonical(key) + canonical((value as any)[key])).join("")}`
  }
  return `v${String(value)};`
}

export function baseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FIDELIS_HOME) return env.FIDELIS_HOME
  if (platform() === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "fidelis")
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "fidelis")
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "fidelis")
}

/** Reversible and path-safe, including `.`, `..` and separators. */
export function safeID(id: string): string {
  return encodeURIComponent(id).replace(/[.*!'()~]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`) || "%empty"
}

function writeAtomic(path: string, data: string) {
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch (error: any) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined
    throw error
  }
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

function lock(path: string) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 })
      return
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error
      const age = (() => {
        try {
          return Date.now() - statSync(path).mtimeMs
        } catch {
          return 0
        }
      })()
      if (age > LOCK_STALE_MS) rmSync(path, { recursive: true, force: true })
      else if (Date.now() > deadline) throw new Error(`fidelis: session lock busy: ${path}`)
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

function newState(host: Host, sessionID: string): SessionState {
  return { host, sessionID, state: "READY", phase: null, revision: 0, updatedAt: 0, turn: 0, corrections: 0, humanIDs: [], boundaries: [], disclosed: [], findings: [], spentUSD: 0 }
}

export class Store {
  readonly dir: string
  readonly host: Host

  constructor(host: Host, dir: string = baseDir()) {
    this.host = host
    this.dir = dir
    mkdirSync(join(dir, "checklists"), { recursive: true, mode: 0o700 })
  }

  private sessionDir(sessionID: string) {
    const dir = join(this.dir, "sessions", safeID(this.host), safeID(sessionID))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  getChecklist(fingerprint: string): Checklist | undefined {
    return readJson<Checklist>(join(this.dir, "checklists", `${safeID(fingerprint)}.json`))
  }

  putChecklist(checklist: Checklist) {
    writeAtomic(join(this.dir, "checklists", `${safeID(checklist.fingerprint)}.json`), JSON.stringify(checklist))
  }

  read(sessionID: string): SessionState {
    return readJson<SessionState>(join(this.sessionDir(sessionID), "state.json")) ?? newState(this.host, sessionID)
  }

  /** Read-modify-write under a short per-session lock. Never held across a model call. */
  update(sessionID: string, change: (state: SessionState) => void): SessionState {
    const dir = this.sessionDir(sessionID)
    const lockPath = join(dir, "lock")
    lock(lockPath)
    try {
      const state = this.read(sessionID)
      change(state)
      state.revision += 1
      state.updatedAt = Date.now()
      writeAtomic(join(dir, "state.json"), JSON.stringify(state))
      return state
    } finally {
      rmSync(lockPath, { recursive: true, force: true })
    }
  }

  appendAudit(sessionID: string, record: AuditRecord) {
    appendFileSync(join(this.sessionDir(sessionID), "audits.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 })
  }

  audits(sessionID: string, limit = 50): AuditRecord[] {
    try {
      const lines = readFileSync(join(this.sessionDir(sessionID), "audits.jsonl"), "utf8").trim().split("\n")
      return lines.slice(-limit).flatMap((line) => {
        try {
          return [JSON.parse(line) as AuditRecord]
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }

  /** Evidence that must survive host compaction. Holds redacted, clipped events by default. */
  readLedger(sessionID: string): ExecEvent[] {
    return readJson<ExecEvent[]>(join(this.sessionDir(sessionID), "ledger.json")) ?? []
  }

  writeLedger(sessionID: string, events: ExecEvent[]) {
    writeAtomic(join(this.sessionDir(sessionID), "ledger.json"), JSON.stringify(events))
  }

  cleanup(retentionDays: number, now = Date.now()) {
    const cutoff = now - retentionDays * 86_400_000
    const prune = (dir: string) => {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const path = join(dir, name)
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true })
      }
    }
    prune(join(this.dir, "checklists"))
    prune(join(this.dir, "sessions", safeID(this.host)))
  }
}
