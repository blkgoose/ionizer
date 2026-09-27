import { ionClient } from "../api/client"
import type { RadarContactEntry } from "../api/types"

// Nearby ships/asteroids can actually move meaningfully within the 10km scan range (radar.rs's
// RADAR_SCAN_DISTANCE) between polls, unlike SystemMap's cached stars/planets — but still far
// slower than ship state itself needs to refresh.
const POLL_INTERVAL_MS = 1000

type Listener = (entries: RadarContactEntry[]) => void

export class RadarPoller {
  private moduleId: string | null = null
  private timer: number | undefined
  private listeners = new Set<Listener>()
  private latest: RadarContactEntry[] = []

  setModuleId(id: string | null): void {
    if (id === this.moduleId) return
    this.moduleId = id
    if (id) void this.scan()
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = window.setInterval(() => void this.scan(), POLL_INTERVAL_MS)
  }

  getLatest(): RadarContactEntry[] {
    return this.latest
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async scan(): Promise<void> {
    if (!this.moduleId) return
    try {
      const entries = await ionClient.actionJson<RadarContactEntry[]>(this.moduleId, "scan")
      this.latest = entries
      this.listeners.forEach((listener) => listener(entries))
    } catch (err) {
      console.error("Radar scan failed", err)
    }
  }
}

export const radarPoller = new RadarPoller()
