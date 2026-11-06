// Installs the packed tarballs into a clean directory and runs them, so a workspace link cannot hide packaging bugs.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const root = mkdtempSync(join(tmpdir(), "fidelis-pack-"))
for (const name of ["@insign/fidelis", "@insign/fidelis-claude-code", "@insign/fidelis-opencode"]) {
  execFileSync("npm", ["pack", "--workspace", name, "--pack-destination", root], { cwd: repo, stdio: "ignore" })
}
const tarballs = readdirSync(root).filter((name) => name.endsWith(".tgz")).map((name) => join(root, name))
writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}')
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--omit=peer", ...tarballs], { cwd: root, stdio: "ignore" })

const cli = join(root, "node_modules/@insign/fidelis-claude-code/dist/cli.js")
const nested = spawnSync("node", [cli, "hook"], { input: "{}", env: { ...process.env, FIDELIS_NESTED: "1" }, encoding: "utf8" })
if (nested.status !== 0 || nested.stdout !== "") throw new Error(`hook failed: ${nested.stderr}`)
const session = spawnSync("node", [cli, "hook"], { input: JSON.stringify({ hook_event_name: "SessionStart", cwd: root }), env: { ...process.env, FIDELIS_HOME: join(root, "home") }, encoding: "utf8" })
if (session.status !== 0) throw new Error(`SessionStart failed: ${session.stderr}`)
console.log(`PASS tarballs install and the hook runs (${tarballs.length} packages)`)
console.log(join(root, "node_modules/@insign/fidelis-opencode"))
