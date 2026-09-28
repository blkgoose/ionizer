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
  private list: HTMLUListElement
  private onSelect: SystemPanelSelectHandler | undefined
  // Rows are reused across updates (keyed by entry index + kind) instead of re-rendering via
  // innerHTML: this panel updates at ship-state poll rate, and replacing the <li> between
  // mousedown and mouseup makes the browser retarget the click to the panel itself.
  private rows = new Map<string, HTMLLIElement>()

  /**
   * `onSelect`, if given, makes each row clickable — stars/planets are tiny, distant skybox dots
   * in the 3D view and genuinely hard to click there, so this is an alternate way to open the same
   * context menu (target/approach/orbit) without hunting for the dot on screen.
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
      // Otherwise the click reaches ContextMenu's window-level dismiss listener right after
      // onSelect opens the menu, hiding it immediately.
      event.stopPropagation()
      this.onSelect(Number(li.dataset.entryIndex), li.dataset.kind ?? "", event.clientX, event.clientY)
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
      const text = `${icon} ${label} — ${formatDistance(r.distanceM)}, ⌀ ${(r.diameter_m / 1000).toFixed(0)} km`
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
