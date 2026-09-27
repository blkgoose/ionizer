import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

const LIGHT_YEAR_M = 9.4607e15
const AU_M = 1.496e11

// Distances inside a single system are km/AU-scale (a system-map scan radius is ~1 ly, but
// anything actually orbiting a star sits many orders of magnitude closer) — showing those in ly
// rounds everything down to 0.000. Pick the coarsest unit that still gives a readable number.
function formatDistance(distanceM: number): string {
  if (distanceM < AU_M * 0.01) return `${(distanceM / 1000).toFixed(0)} km`
  if (distanceM < LIGHT_YEAR_M * 0.1) return `${(distanceM / AU_M).toFixed(3)} AU`
  return `${(distanceM / LIGHT_YEAR_M).toFixed(3)} ly`
}

export class SystemPanel {
  private el: HTMLDivElement

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "system-panel"
    container.appendChild(this.el)
  }

  update(shipPosition: FloatingOriginPosition, entries: SystemMapEntry[]): void {
    const rows = entries
      .map((entry) => {
        const [dx, dy, dz] = relativeVector(shipPosition, entry.position)
        return { ...entry, distanceM: Math.hypot(dx, dy, dz) }
      })
      .sort((a, b) => a.distanceM - b.distanceM)

    const stars = rows.filter((r) => r.kind === "star")
    const planets = rows.filter((r) => r.kind === "planet")

    if (rows.length === 0) {
      this.el.innerHTML = ""
      return
    }

    this.el.innerHTML = `
      <h4>Sistema stellare</h4>
      <ul>
        ${stars.map((s) => `<li>☉ stella — ${formatDistance(s.distanceM)}, ⌀ ${(s.diameter_m / 1000).toFixed(0)} km</li>`).join("")}
        ${planets.map((p) => `<li>● pianeta — ${formatDistance(p.distanceM)}, ⌀ ${(p.diameter_m / 1000).toFixed(0)} km</li>`).join("")}
      </ul>
    `
  }
}
