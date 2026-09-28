export interface ContextMenuAction {
  label: string
  onSelect: () => void
}

/** A bare HTML popup menu positioned at a click's screen coordinates. */
export class ContextMenu {
  private el: HTMLDivElement

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "context-menu"
    container.appendChild(this.el)
    // Any other click (including a click that opens a *different* menu, since that click
    // reaches window after this handler runs the new show()) dismisses the menu.
    window.addEventListener("click", () => this.hide())
  }

  show(clientX: number, clientY: number, title: string, actions: ContextMenuAction[]): void {
    this.el.innerHTML = ""
    const heading = document.createElement("div")
    heading.className = "context-menu-title"
    heading.textContent = title
    this.el.appendChild(heading)

    for (const action of actions) {
      const item = document.createElement("button")
      item.textContent = action.label
      item.addEventListener("click", (e) => {
        e.stopPropagation()
        action.onSelect()
        this.hide()
      })
      this.el.appendChild(item)
    }

    this.el.style.left = `${clientX}px`
    this.el.style.top = `${clientY}px`
    this.el.style.display = "flex"
  }

  hide(): void {
    this.el.style.display = "none"
  }
}
