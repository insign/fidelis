// Same id and method names as packages/opencode/src/rpc.ts, importable from Node without type stripping under node_modules.
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const { Rpc } = await import(join(repo, "node_modules/@opencode/plugin/dist/rpc.js"))
export const FidelisRpc = Rpc.define({ id: "fidelis", methods: { status: { input: { type: "object" }, output: { type: "object" } } } })
