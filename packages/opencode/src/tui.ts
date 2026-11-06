import { Plugin } from "@opencode/plugin/tui"
import { createComponent, createElement, effect, insert, setProp } from "@opentui/solid"
import { createEffect, createSignal, For, Show } from "solid-js"
import { FidelisRpc } from "./rpc.ts"
import { footerLabel, panelLines, shouldApply, toastFor, UI_DEFAULTS, type Status } from "./view.ts"

// Plain calls instead of JSX: a .tsx file fails to load from node_modules on OpenCode 2.2.5, which is where a published plugin lives.
function el(tag: string, props: Record<string, () => unknown>, ...children: unknown[]): any {
  const node = createElement(tag)
  for (const [name, read] of Object.entries(props)) effect(() => setProp(node, name, read()))
  for (const child of children) insert(node, child as any)
  return node
}

const PANEL = "fidelis.audit"
const MAX_SEEN = 200

export default Plugin.define({
  id: "fidelis.tui",
  setup(context: any) {
    // The server holds the plugin's options; this part does not receive them from a server-loaded entry.
    const [ui, setUi] = createSignal({ ...UI_DEFAULTS, ...(context.options?.ui ?? {}) })
    const location = () => context.location ?? context.data.location.default()
    const [statuses, setStatuses] = createSignal<Record<string, Status>>({})
    const [seen, updateSeen] = context.storage.store("toasts", { initial: { keys: [] as string[] } })
    const api = () => context.client.rpc(FidelisRpc)
    const selected = () => {
      const route = context.ui.router.current()
      return route?.type === "session" ? (route.sessionID as string) : undefined
    }

    // The server owns state. Events are live-only, so each one and each reconnect re-reads a snapshot.
    const refresh = async (sessionID: string) => {
      try {
        // RPC methods resolve per location, so the plugin instance that owns this directory answers.
        const next = (await api().status({ sessionID }, { location: location() })) as Status
        setStatuses((all) => (shouldApply(all[sessionID], next) ? { ...all, [sessionID]: next } : all))
      } catch {
        // Server part absent or disconnected: the footer stays neutral and auditing is unaffected.
      }
    }

    const loadUi = () => api().ui({}, { location: location() }).then((next: any) => setUi((current) => ({ ...current, ...next })), () => {})
    void loadUi()

    const subscribe = () =>
      api().events.on("changed", (event: any) => {
        const data = event.data
        void refresh(data.sessionID)
        const toast = ui().enabled ? toastFor(data, ui().notifications) : null
        if (!toast || seen.keys.includes(toast.key)) return
        void updateSeen((draft: { keys: string[] }) => {
          draft.keys = [...draft.keys, toast.key].slice(-MAX_SEEN)
        })
        context.ui.toast.show({ title: toast.title, message: toast.message, variant: toast.variant, duration: 6000 })
      })

    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = subscribe()
    } catch {
      unsubscribe = undefined
    }
    const stopConnected = context.data.on("server.connected", () => {
      unsubscribe?.()
      unsubscribe = subscribe()
      void loadUi()
      const id = selected()
      if (id) void refresh(id)
    })

    const footer = () => {
      createEffect(() => {
        const id = selected()
        if (id) void refresh(id)
      })
      const status = () => {
        const id = selected()
        return id ? statuses()[id] : undefined
      }
      return el("text", { fg: () => context.theme.text.base }, () => footerLabel(status(), ui().plainTextIcons))
    }

    const auditPanel = (panel: any) => {
      context.keymap.layer(() => ({ commands: [{ id: "fidelis.audit.close", bind: "escape", run: () => panel.close() }] }))
      createEffect(() => void refresh(panel.sessionID))
      const tone = (name: string) => (name === "muted" ? context.theme.text.muted : name === "warning" ? context.theme.status?.warning : context.theme.text.base) ?? context.theme.text.base
      return el(
        "box",
        { flexDirection: () => "column", flexGrow: () => 1, paddingLeft: () => 1, paddingRight: () => 1 },
        el("text", { fg: () => context.theme.text.base }, "Fidelis audit"),
        el(
          "scrollbox",
          { flexGrow: () => 1, focused: () => panel.focused },
          createComponent(For, {
            get each() {
              return panelLines(statuses()[panel.sessionID])
            },
            children: (line: any) => el("text", { fg: () => tone(line.tone), wrapMode: () => "word" }, line.text || " "),
          }),
        ),
      )
    }

    const when = (test: () => boolean, render: () => unknown) =>
      createComponent(Show, {
        get when() {
          return test()
        },
        get children() {
          return render()
        },
      })
    const disposers: (() => void)[] = []
    for (const slot of ["home.footer.status", "prompt.footer.status"]) disposers.push(context.ui.slot({ append: slot, render: () => when(() => ui().enabled && ui().footer, footer) }))
    disposers.push(context.ui.slot({ append: "session.panel", render: (panel: any) => when(() => panel.name === PANEL && ui().enabled && ui().auditPanel, () => auditPanel(panel)) }))
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fidelis.open",
          title: "Fidelis: show audit",
          group: "Fidelis",
          palette: true,
          slash: { name: "fidelis" },
          run: () => {
            if (!ui().enabled || !ui().auditPanel) return
            if (!context.ui.panel.open(PANEL)) context.ui.toast.show({ title: "Fidelis", message: "Open a session to see its audit.", variant: "info" })
          },
        },
      ],
    }))

    return () => {
      unsubscribe?.()
      stopConnected()
      for (const dispose of disposers) dispose?.()
    }
  },
})
