import { Rpc } from "@opencode/plugin/rpc"

const anyObject = { type: "object" } as const

export const FidelisRpc = Rpc.define({
  id: "fidelis",
  methods: {
    status: { input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false }, output: anyObject },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          revision: { type: "number" },
          state: { type: "string" },
          phase: {},
          auditID: {},
          transition: { type: "string" },
          updatedAt: { type: "number" },
          actionable: { type: "number" },
        },
        required: ["sessionID", "revision", "state", "transition", "updatedAt"],
      },
    },
  },
})
