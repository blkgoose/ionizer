import type { FloatingOriginPosition, RadarContactEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

export class RadarPanel {
  private el: HTMLDivElement

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "radar-panel"
    container.appendChild(this.el)
  }

  update(shipPosition: FloatingOriginPosition, contacts: RadarContactEntry[]): void {
    if (contacts.length === 0) {
      this.el.innerHTML = ""
      return
    }

    const rows = contacts
      .map(([entityId, position, size]) => {
        const [dx, dy, dz] = relativeVector(shipPosition, position)
        return { entityId, size, distanceM: Math.hypot(dx, dy, dz) }
      })
      .sort((a, b) => a.distanceM - b.distanceM)

    this.el.innerHTML = `
      <h4>Contatti radar</h4>
      <ul>
        ${rows
          .map((r) => `<li>▲ ${r.entityId.slice(0, 8)} — ${(r.distanceM / 1000).toFixed(2)} km, ⌀ ${r.size.toFixed(0)} m</li>`)
          .join("")}
      </ul>
    `
  }
}
