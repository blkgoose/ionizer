import type { FloatingOriginPosition, RadarContactEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

export type RadarPanelSelectHandler = (entityId: string) => void

export class RadarPanel {
  private el: HTMLDivElement
  private list: HTMLUListElement
  private onSelect: RadarPanelSelectHandler | undefined
  // Rows are reused across updates (keyed by entity id) instead of re-rendering via innerHTML —
  // same reasoning as SystemPanel: replacing the <li> between mousedown and mouseup would
  // retarget the click to the panel itself instead of the row.
  private rows = new Map<string, HTMLLIElement>()

  /**
   * `onSelect`, if given, makes each row clickable — an alternate way to open the same command
   * palette actions (target/approach/point/orbit) a 3D-view contact click would, for contacts
   * that are tiny or off-screen.
   */
  constructor(container: HTMLElement, onSelect?: RadarPanelSelectHandler) {
    this.el = document.createElement("div")
    this.el.className = "radar-panel"
    this.onSelect = onSelect
    const heading = document.createElement("h4")
    heading.textContent = "Contatti radar"
    this.list = document.createElement("ul")
    this.el.append(heading, this.list)
    this.el.style.display = "none"
    container.appendChild(this.el)

    this.el.addEventListener("click", (event) => {
      if (!this.onSelect) return
      const li = (event.target as HTMLElement).closest<HTMLLIElement>("li[data-entity-id]")
      if (!li) return
      this.onSelect(li.dataset.entityId!)
    })
  }

  update(shipPosition: FloatingOriginPosition, contacts: RadarContactEntry[]): void {
    const rows = contacts
      .map(([entityId, position, size]) => {
        const [dx, dy, dz] = relativeVector(shipPosition, position)
        return { entityId, size, distanceM: Math.hypot(dx, dy, dz) }
      })
      .sort((a, b) => a.distanceM - b.distanceM)

    this.el.style.display = rows.length === 0 ? "none" : ""

    const seen = new Set<string>()
    rows.forEach((r, position) => {
      seen.add(r.entityId)
      let li = this.rows.get(r.entityId)
      if (!li) {
        li = document.createElement("li")
        li.className = `radar-panel-row${this.onSelect ? " clickable" : ""}`
        li.dataset.entityId = r.entityId
        this.rows.set(r.entityId, li)
      }
      const text = `▲ ${r.entityId.slice(0, 8)} — ${(r.distanceM / 1000).toFixed(2)} km, ⌀ ${r.size.toFixed(0)} m`
      if (li.textContent !== text) li.textContent = text
      if (this.list.children[position] !== li) this.list.insertBefore(li, this.list.children[position] ?? null)
    })

    for (const [entityId, li] of this.rows) {
      if (!seen.has(entityId)) {
        li.remove()
        this.rows.delete(entityId)
      }
    }
  }
}
