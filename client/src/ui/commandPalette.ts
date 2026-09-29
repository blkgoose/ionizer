import { setInputCaptured } from "../state/inputCapture"

export type PaletteNode =
  | { kind: "list"; load: () => PaletteItem[] | Promise<PaletteItem[]> }
  // Like "list", but picking a "run" leaf inside it pops back to this list's parent instead of
  // closing the whole palette — a picker (e.g. "choose which FuelCell") isn't itself the terminal
  // action, the pick is.
  | { kind: "picker"; load: () => PaletteItem[] | Promise<PaletteItem[]> }
  | { kind: "run"; run: () => void | Promise<void> }
  // A mutable value: Enter opens an inline text field pre-filled with `value`; Enter again calls
  // `commit` and pops back to the enclosing list (not the whole palette) — also used for action
  // params (space-separated in the same field), where `value` starts blank.
  | { kind: "edit"; value: string; commit: (value: string) => void | Promise<void> }
  // Read-only display row — selectable for keyboard nav, but Enter does nothing.
  | { kind: "info" }

export interface PaletteItem {
  label: string
  node: PaletteNode
}

interface Frame {
  title: string
  items: PaletteItem[] | null // null while its `load()` is in flight
  // Set when this frame was pushed by a "picker" node (see above) — makes a "run" leaf inside it
  // pop back to the enclosing list instead of closing the palette.
  popOnRun?: boolean
}

/**
 * Ctrl+K grouped command palette: root items (built fresh on each open by `getRootItems`, so it
 * always reflects the ship's current module loadout) drill into module lists, then each module's
 * MAN manifest (variables + actions), fzf-style — a single always-focused text field filters the
 * current level's items live, Enter descends/runs/edits, Backspace-on-empty or Escape goes back a
 * level instead of just closing, mirroring how a shell fuzzy-finder feels.
 */
export class CommandPalette {
  private el: HTMLDivElement
  private breadcrumbEl: HTMLDivElement
  private input: HTMLInputElement
  private list: HTMLUListElement
  private isOpen = false
  private getRootItems: () => PaletteItem[]
  private stack: Frame[] = []
  private selectedIndex = 0
  private editing: { item: PaletteItem; node: Extract<PaletteNode, { kind: "edit" }> } | null = null
  // Bumped on every render() and captured by async load()s so a stale manifest fetch that resolves
  // after the player has already navigated elsewhere can't clobber a since-changed frame.
  private renderToken = 0

  constructor(container: HTMLElement, getRootItems: () => PaletteItem[]) {
    this.getRootItems = getRootItems
    this.el = document.createElement("div")
    this.el.className = "command-palette-modal hidden"
    const panel = document.createElement("div")
    panel.className = "command-palette-panel"
    this.breadcrumbEl = document.createElement("div")
    this.breadcrumbEl.className = "command-palette-breadcrumb"
    this.input = document.createElement("input")
    this.input.className = "command-palette-input"
    this.input.autocomplete = "off"
    this.input.spellcheck = false
    this.list = document.createElement("ul")
    this.list.className = "command-palette-list"
    panel.append(this.breadcrumbEl, this.input, this.list)
    this.el.appendChild(panel)
    container.appendChild(this.el)

    this.el.addEventListener("click", (event) => {
      const li = (event.target as HTMLElement).closest<HTMLLIElement>("li[data-index]")
      if (li) this.activate(Number(li.dataset.index))
    })

    this.input.addEventListener("input", () => {
      if (!this.editing) this.selectedIndex = 0
      this.render()
    })
    this.input.addEventListener("keydown", (event) => this.onInputKey(event))

    window.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "k" && (this.isOpen || document.activeElement?.tagName !== "INPUT")) {
        event.preventDefault()
        this.toggle()
      }
    })
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private open(): void {
    this.openWithStack([{ title: "Comandi", items: this.getRootItems() }])
  }

  /**
   * Opens the palette pre-loaded at a single list instead of the root command tree — e.g. the
   * Orbit/Approach/Point/Target actions for a ship or body clicked in the 3D view or a side panel.
   * Replaces the old standalone right-click context menu: same trigger, same actions, but rendered
   * through the palette's own filter/keyboard-nav UI instead of a separate positioned popup.
   */
  openList(title: string, items: PaletteItem[]): void {
    this.openWithStack([{ title, items }])
  }

  private openWithStack(stack: Frame[]): void {
    this.isOpen = true
    this.el.classList.remove("hidden")
    setInputCaptured(true)
    this.editing = null
    this.stack = stack
    this.selectedIndex = 0
    this.input.value = ""
    this.render()
    this.input.focus()
  }

  close(): void {
    this.isOpen = false
    this.el.classList.add("hidden")
    setInputCaptured(false)
    this.editing = null
  }

  private get currentFrame(): Frame {
    return this.stack[this.stack.length - 1]
  }

  private filteredItems(): PaletteItem[] {
    const items = this.currentFrame.items ?? []
    const query = this.editing ? "" : this.input.value.trim().toLowerCase()
    if (!query) return items
    return items.filter((item) => item.label.toLowerCase().includes(query))
  }

  private onInputKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault()
      if (this.editing) this.cancelEdit()
      else if (this.stack.length > 1) this.popFrame()
      else this.close()
      return
    }
    if (this.editing) {
      if (event.key === "Enter") {
        event.preventDefault()
        this.commitEdit()
      }
      return // any other key is native input editing of the draft value
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      this.move(1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      this.move(-1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      this.activate(this.selectedIndex)
    } else if (event.key === "Backspace" && this.input.value === "" && this.stack.length > 1) {
      event.preventDefault()
      this.popFrame()
    }
  }

  private move(delta: number): void {
    const items = this.filteredItems()
    if (items.length === 0) return
    this.selectedIndex = (this.selectedIndex + delta + items.length) % items.length
    this.render()
  }

  private popFrame(): void {
    this.stack.pop()
    this.selectedIndex = 0
    this.input.value = ""
    this.render()
  }

  private activate(filteredIndex: number): void {
    if (this.editing) return
    const item = this.filteredItems()[filteredIndex]
    if (!item) return

    switch (item.node.kind) {
      case "info":
        return
      case "run":
        if (this.currentFrame.popOnRun) this.popFrame()
        else this.close()
        void item.node.run()
        return
      case "edit":
        this.editing = { item, node: item.node }
        this.input.value = item.node.value
        this.render()
        this.input.focus()
        this.input.select()
        return
      case "list":
      case "picker": {
        const token = ++this.renderToken
        this.stack.push({ title: item.label, items: null, popOnRun: item.node.kind === "picker" })
        this.selectedIndex = 0
        this.input.value = ""
        this.render()
        void Promise.resolve(item.node.load()).then((loaded) => {
          if (token !== this.renderToken) return
          this.currentFrame.items = loaded
          this.render()
        })
        return
      }
    }
  }

  private commitEdit(): void {
    if (!this.editing) return
    const { node } = this.editing
    void node.commit(this.input.value)
    this.editing = null
    this.input.value = ""
    this.render()
  }

  private cancelEdit(): void {
    this.editing = null
    this.input.value = ""
    this.render()
  }

  private render(): void {
    this.breadcrumbEl.textContent = this.editing
      ? `${this.stack.map((f) => f.title).join(" › ")} › ${this.editing.item.label}`
      : this.stack.map((f) => f.title).join(" › ")

    this.list.innerHTML = ""

    if (this.currentFrame.items === null) {
      const loading = document.createElement("li")
      loading.className = "command-palette-empty"
      loading.textContent = "Caricamento…"
      this.list.appendChild(loading)
      return
    }

    const items = this.filteredItems()
    if (items.length === 0) {
      const empty = document.createElement("li")
      empty.className = "command-palette-empty"
      empty.textContent = "Nessun risultato."
      this.list.appendChild(empty)
      return
    }

    items.forEach((item, index) => {
      const li = document.createElement("li")
      li.dataset.index = String(index)
      const classes = ["command-palette-row"]
      if (index === this.selectedIndex) classes.push("active")
      if (item.node.kind === "info") classes.push("info")
      if (item.node.kind === "list" || item.node.kind === "picker") classes.push("has-children")
      li.className = classes.join(" ")
      li.textContent = item.label
      this.list.appendChild(li)
    })
  }
}
