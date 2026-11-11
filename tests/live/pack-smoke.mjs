// Installs the packed tarballs into a clean directory and runs them, so a workspace link cannot hide packaging bugs.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const root = mkdtempSync(join(tmpdir(), "fidelis-pack-"))
for (const name of ["fidelis", "fidelis-claude-code", "fidelis-opencode"]) {
  execFileSync("npm", ["pack", "--workspace", name, "--pack-destination", root], { cwd: repo, stdio: "ignore" })
}
const tarballs = readdirSync(root).filter((name) => name.endsWith(".tgz")).map((name) => join(root, name))
writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}')
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--omit=peer", ...tarballs], { cwd: root, stdio: "ignore" })

const cli = join(root, "node_modules/fidelis-claude-code/dist/cli.js")
const hook = (input) => spawnSync("node", [cli, "hook"], { input: JSON.stringify(input), encoding: "utf8" })
const first = hook({ hook_event_name: "Stop", session_id: "s", stop_hook_active: false })
if (first.status !== 0 || !JSON.parse(first.stdout).hookSpecificOutput?.additionalContext?.startsWith("[Fidelis:")) throw new Error(`no review: ${first.stdout} ${first.stderr}`)
const again = hook({ hook_event_name: "Stop", session_id: "s", stop_hook_active: true })
if (again.status !== 0 || again.stdout !== "") throw new Error(`reviewed a continuation: ${again.stdout} ${again.stderr}`)
console.log(`PASS tarballs install and the Stop hook reviews once (${tarballs.length} packages)`)
console.log(join(root, "node_modules/fidelis-opencode"))
