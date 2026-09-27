import { ionClient } from "../api/client"
import type { SystemMapEntry } from "../api/types"

// The catalog docs this as "cached procedural generation data — no live scan": it only
// changes when the ship crosses into a different galaxy sector, so polling far less often
// than ship state (150ms) is enough — this just needs to notice a sector change eventually.
const POLL_INTERVAL_MS = 5000

type Listener = (entries: SystemMapEntry[]) => void

export class SystemMapPoller {
  private moduleId: string | null = null
  private timer: number | undefined
  private listeners = new Set<Listener>()
  private latest: SystemMapEntry[] = []

  setModuleId(id: string | null): void {
    if (id === this.moduleId) return
    this.moduleId = id
    if (id) void this.scan()
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = window.setInterval(() => void this.scan(), POLL_INTERVAL_MS)
  }

  getLatest(): SystemMapEntry[] {
    return this.latest
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async scan(): Promise<void> {
    if (!this.moduleId) return
    try {
      const entries = await ionClient.actionJson<SystemMapEntry[]>(this.moduleId, "scan")
      this.latest = entries
      this.listeners.forEach((listener) => listener(entries))
    } catch (err) {
      console.error("SystemMap scan failed", err)
    }
  }
}

export const systemMapPoller = new SystemMapPoller()
