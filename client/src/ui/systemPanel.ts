import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

const LIGHT_YEAR_M = 9.4607e15
const AU_M = 1.496e11
const EARTH_MASS_KG = 5.972e24
const SOLAR_MASS_KG = 1.989e30

// Distances inside a single system are km/AU-scale (a system-map scan radius is ~1 ly, but
// anything actually orbiting a star sits many orders of magnitude closer) — showing those in ly
// rounds everything down to 0.000. Pick the coarsest unit that still gives a readable number.
export function formatDistance(distanceM: number): string {
  if (distanceM < AU_M * 0.01) return `${(distanceM / 1000).toFixed(0)} km`
  if (distanceM < LIGHT_YEAR_M * 0.1) return `${(distanceM / AU_M).toFixed(3)} AU`
  return `${(distanceM / LIGHT_YEAR_M).toFixed(3)} ly`
}

// mass_kg spans ~7 orders of magnitude for planets alone (galaxy.rs: ATTRACTOR_MINIMUM_MASS to
// MAX_PLANET_MASS_KG) and stars go well past that — raw kg is unreadable at either end, so use
// whichever of Earth/solar masses keeps the number in a sane range.
export function formatMass(massKg: number): string {
  if (massKg >= SOLAR_MASS_KG * 0.01) return `${(massKg / SOLAR_MASS_KG).toFixed(3)} M☉`
  return `${(massKg / EARTH_MASS_KG).toFixed(2)} M⊕`
}

export type SystemPanelSelectHandler = (entryIndex: number, kind: string) => void

export class SystemPanel {
  private el: HTMLDivElement
  private list: HTMLUListElement
  private onSelect: SystemPanelSelectHandler | undefined
  // Rows are reused across updates (keyed by entry index + kind) instead of re-rendering via
  // innerHTML: this panel updates at ship-state poll rate, and replacing the <li> between
  // mousedown and mouseup makes the browser retarget the click to the panel itself.
  private rows = new Map<string, HTMLLIElement>()

  /**
   * `onSelect`, if given, makes each row clickable — stars/planets are tiny, distant skybox dots
   * in the 3D view and genuinely hard to click there, so this is an alternate way to open the same
   * command palette actions (target/approach/orbit) without hunting for the dot on screen.
   */
  constructor(container: HTMLElement, onSelect?: SystemPanelSelectHandler) {
    this.el = document.createElement("div")
    this.el.className = "system-panel"
    this.onSelect = onSelect
    const heading = document.createElement("h4")
    heading.textContent = "Sistema stellare"
    this.list = document.createElement("ul")
    this.el.append(heading, this.list)
    this.el.style.display = "none"
    container.appendChild(this.el)

    this.el.addEventListener("click", (event) => {
      if (!this.onSelect) return
      const li = (event.target as HTMLElement).closest<HTMLLIElement>("li[data-entry-index]")
      if (!li) return
      this.onSelect(Number(li.dataset.entryIndex), li.dataset.kind ?? "")
    })
  }

  update(shipPosition: FloatingOriginPosition, entries: SystemMapEntry[]): void {
    const rows = entries
      .map((entry, entryIndex) => {
        const [dx, dy, dz] = relativeVector(shipPosition, entry.position)
        return { ...entry, entryIndex, distanceM: Math.hypot(dx, dy, dz) }
      })
      .filter((r) => r.kind === "star" || r.kind === "planet")
      .sort((a, b) => a.distanceM - b.distanceM)

    const stars = rows.filter((r) => r.kind === "star")
    const planets = rows.filter((r) => r.kind === "planet")
    const ordered = [...stars, ...planets]

    this.el.style.display = ordered.length === 0 ? "none" : ""

    const seen = new Set<string>()
    ordered.forEach((r, position) => {
      const key = `${r.entryIndex}:${r.kind}`
      seen.add(key)
      let li = this.rows.get(key)
      if (!li) {
        li = document.createElement("li")
        li.className = `system-panel-row${this.onSelect ? " clickable" : ""}`
        li.dataset.entryIndex = String(r.entryIndex)
        li.dataset.kind = r.kind
        this.rows.set(key, li)
      }
      const icon = r.kind === "star" ? "☉" : "●"
      const label = r.kind === "star" ? "stella" : "pianeta"
      const text = `${icon} ${label} — ${formatDistance(r.distanceM)}, ⌀ ${(r.diameter_m / 1000).toFixed(0)} km, ${formatMass(r.mass_kg)}`
      if (li.textContent !== text) li.textContent = text
      if (this.list.children[position] !== li) this.list.insertBefore(li, this.list.children[position] ?? null)
    })

    for (const [key, li] of this.rows) {
      if (!seen.has(key)) {
        li.remove()
        this.rows.delete(key)
      }
    }
  }
}
