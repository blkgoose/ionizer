import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

const LIGHT_YEAR_M = 9.4607e15
const AU_M = 1.496e11

// Distances inside a single system are km/AU-scale (a system-map scan radius is ~1 ly, but
// anything actually orbiting a star sits many orders of magnitude closer) — showing those in ly
// rounds everything down to 0.000. Pick the coarsest unit that still gives a readable number.
export function formatDistance(distanceM: number): string {
  if (distanceM < AU_M * 0.01) return `${(distanceM / 1000).toFixed(0)} km`
  if (distanceM < LIGHT_YEAR_M * 0.1) return `${(distanceM / AU_M).toFixed(3)} AU`
  return `${(distanceM / LIGHT_YEAR_M).toFixed(3)} ly`
}

export type SystemPanelSelectHandler = (entryIndex: number, kind: string, clientX: number, clientY: number) => void

export class SystemPanel {
  private el: HTMLDivElement
  private onSelect: SystemPanelSelectHandler | undefined

  /**
   * `onSelect`, if given, makes each row clickable — stars/planets are tiny, distant skybox dots
   * in the 3D view and genuinely hard to click there, so this is an alternate way to open the same
   * context menu (target/approach/orbit) without hunting for the dot on screen.
   */
  constructor(container: HTMLElement, onSelect?: SystemPanelSelectHandler) {
    this.el = document.createElement("div")
    this.el.className = "system-panel"
    this.onSelect = onSelect
    container.appendChild(this.el)

    this.el.addEventListener("click", (event) => {
      if (!this.onSelect) return
      const li = (event.target as HTMLElement).closest<HTMLLIElement>("li[data-entry-index]")
      if (!li) return
      this.onSelect(Number(li.dataset.entryIndex), li.dataset.kind ?? "", event.clientX, event.clientY)
    })
  }

  update(shipPosition: FloatingOriginPosition, entries: SystemMapEntry[]): void {
    const rows = entries
      .map((entry, entryIndex) => {
        const [dx, dy, dz] = relativeVector(shipPosition, entry.position)
        return { ...entry, entryIndex, distanceM: Math.hypot(dx, dy, dz) }
      })
      .sort((a, b) => a.distanceM - b.distanceM)

    const stars = rows.filter((r) => r.kind === "star")
    const planets = rows.filter((r) => r.kind === "planet")

    if (rows.length === 0) {
      this.el.innerHTML = ""
      return
    }

    const clickable = this.onSelect ? " clickable" : ""
    const row = (r: (typeof rows)[number], icon: string, label: string) =>
      `<li class="system-panel-row${clickable}" data-entry-index="${r.entryIndex}" data-kind="${r.kind}">${icon} ${label} — ${formatDistance(r.distanceM)}, ⌀ ${(r.diameter_m / 1000).toFixed(0)} km</li>`

    this.el.innerHTML = `
      <h4>Sistema stellare</h4>
      <ul>
        ${stars.map((s) => row(s, "☉", "stella")).join("")}
        ${planets.map((p) => row(p, "●", "pianeta")).join("")}
      </ul>
    `
  }
}
