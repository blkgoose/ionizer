export interface PointPickerEntry {
  label: string
  distanceM: number
  /** Opens the same context menu (orbit/approach/point/target) a 3D-view or panel click would. */
  onOpen: () => void
}

/**
 * Ctrl+K command palette listing every known point (system-map bodies + scanner contacts) sorted
 * by distance, so the player can pick a target without hunting for a tiny dot on screen or in the
 * side panels. Snapshots the list at open time (via `getEntries`) rather than live-updating while
 * open — same tradeoff as a typical command palette, and avoids wiring this into the ship-state
 * poll loop just for a picker that's open for a few seconds at a time.
 */
export class PointPicker {
  private el: HTMLDivElement
  private list: HTMLUListElement
  private isOpen = false
  private entries: PointPickerEntry[] = []
  private selectedIndex = 0
  private getEntries: () => PointPickerEntry[]

  constructor(container: HTMLElement, getEntries: () => PointPickerEntry[]) {
    this.getEntries = getEntries
    this.el = document.createElement("div")
    this.el.className = "point-picker-modal hidden"
    const panel = document.createElement("div")
    panel.className = "point-picker-panel"
    const heading = document.createElement("h4")
    heading.textContent = "Vai a…"
    this.list = document.createElement("ul")
    this.list.className = "point-picker-list"
    panel.append(heading, this.list)
    this.el.appendChild(panel)
    container.appendChild(this.el)

    this.el.addEventListener("click", (event) => {
      const li = (event.target as HTMLElement).closest<HTMLLIElement>("li[data-index]")
      if (li) this.activate(Number(li.dataset.index))
    })

    window.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault()
        this.toggle()
        return
      }
      if (!this.isOpen) return
      if (event.key === "Escape") {
        event.preventDefault()
        this.close()
      } else if (event.key === "ArrowDown") {
        event.preventDefault()
        this.move(1)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        this.move(-1)
      } else if (event.key === "Enter") {
        event.preventDefault()
        this.activate(this.selectedIndex)
      }
    })
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private open(): void {
    this.entries = this.getEntries()
    this.selectedIndex = 0
    this.isOpen = true
    this.el.classList.remove("hidden")
    this.render()
  }

  close(): void {
    this.isOpen = false
    this.el.classList.add("hidden")
  }

  private move(delta: number): void {
    if (this.entries.length === 0) return
    this.selectedIndex = (this.selectedIndex + delta + this.entries.length) % this.entries.length
    this.render()
  }

  private activate(index: number): void {
    const entry = this.entries[index]
    if (!entry) return
    this.close()
    entry.onOpen()
  }

  private render(): void {
    this.list.innerHTML = ""
    if (this.entries.length === 0) {
      const empty = document.createElement("li")
      empty.className = "point-picker-empty"
      empty.textContent = "Nessun punto noto."
      this.list.appendChild(empty)
      return
    }
    this.entries.forEach((entry, index) => {
      const li = document.createElement("li")
      li.dataset.index = String(index)
      li.className = index === this.selectedIndex ? "active" : ""
      li.textContent = entry.label
      this.list.appendChild(li)
    })
  }
}
