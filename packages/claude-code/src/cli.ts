#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { REVIEW_PROMPT } from "fidelis"

/**
 * One review per turn. `stop_hook_active` is true when this stop ends a continuation that a Stop hook started, which
 * includes the review itself, so the review never reviews itself.
 */
export function stopOutput(input: any): object | null {
  if (input?.hook_event_name !== "Stop" || input.stop_hook_active === true || input.agent_id) return null
  // Work still running in the background means the turn has not really finished.
  if ((input.background_tasks ?? []).some((task: any) => task?.status === "running" || task?.status === "pending")) return null
  return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: REVIEW_PROMPT } }
}

/** Earlier versions also installed a SessionStart hook. Install and uninstall clean it up. */
const HOOK_EVENTS = ["SessionStart", "Stop"]
const STOP_TIMEOUT_SECONDS = 10
const OWN_HOOK = /[\\/](?:fidelis-claude-code|claude-code)[\\/]dist[\\/]cli\.js" hook$/

/** Removes only the Fidelis hook, never a neighbor in the same group. */
export function withoutOwnHook(groups: any[]): any[] {
  return groups.flatMap((group) => {
    const hooks = group.hooks ?? []
    const kept = hooks.filter((hook: any) => !OWN_HOOK.test(hook.command ?? ""))
    return kept.length === hooks.length ? [group] : kept.length ? [{ ...group, hooks: kept }] : []
  })
}

export function withHook(settings: any, command: string, remove: boolean): any {
  const hooks = { ...(settings.hooks ?? {}) }
  for (const event of HOOK_EVENTS) {
    const kept = withoutOwnHook(hooks[event] ?? [])
    hooks[event] = !remove && event === "Stop" ? [...kept, { hooks: [{ type: "command", command, timeout: STOP_TIMEOUT_SECONDS }] }] : kept
    if (hooks[event].length === 0) delete hooks[event]
  }
  return { ...settings, hooks }
}

function settingsPath(project: boolean) {
  return project ? join(process.cwd(), ".claude", "settings.json") : join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")
}

function install(remove: boolean, project: boolean) {
  const path = settingsPath(project)
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
  const command = `node "${realpathSync(fileURLToPath(import.meta.url))}" hook`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(withHook(settings, command, remove), null, 2) + "\n")
  renameSync(`${path}.tmp`, path)
  console.log(`${remove ? "Removed the Fidelis hook from" : "Installed the Fidelis hook in"} ${path}`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2)
  const project = process.argv.includes("--project")
  if (command === "hook") {
    // A malformed input must never wedge the session: no output lets the turn end.
    try {
      const output = stopOutput(JSON.parse(readFileSync(0, "utf8")))
      if (output) process.stdout.write(JSON.stringify(output))
    } catch {}
  } else if (command === "install") install(false, project)
  else if (command === "uninstall") install(true, project)
  else console.error("usage: fidelis-claude-code <install|uninstall|hook> [--project]")
}
