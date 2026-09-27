import { ionClient } from "../api/client"
import type { ModuleManifest, VariableManifest } from "../api/types"
import { TAB_LABELS, tabForModuleType, type ModuleTab } from "../api/modules"
import { formatDuration, isSecondsField } from "../api/duration"
import type { ModuleRef } from "../state/shipState"

const TAB_ORDER: ModuleTab[] = ["cargo", "propulsion", "armaments", "crafting"]
const DETAIL_REFRESH_MS = 1000

export class ModulesModal {
  private el: HTMLDivElement
  private activeTab: ModuleTab = "cargo"
  private isOpen = false
  private modules: ModuleRef[] = []
  private modulesSignature = ""
  private selectedModuleId: string | null = null
  private refreshTimer: number | undefined

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "modules-modal hidden"
    container.appendChild(this.el)

    // Delegated on the modal root (bound once) rather than per-render: the module
    // list only re-renders when the ship's module set actually changes structurally
    // (not on every 150ms poll tick), so per-render listeners would mostly work
    // fine too, but delegation means a click is never lost to a render in flight.
    this.el.addEventListener("click", (event) => {
      const target = event.target as HTMLElement
      const tabBtn = target.closest<HTMLButtonElement>(".modal-tab")
      if (tabBtn) {
        this.setTab(tabBtn.dataset.tab as ModuleTab)
        return
      }
      const li = target.closest<HTMLLIElement>("[data-module-id]")
      if (li) this.selectModule(li.dataset.moduleId!)
    })

    window.addEventListener("keydown", (event) => {
      if (this.isOpen && document.activeElement?.tagName === "INPUT") return
      if (event.key.toLowerCase() === "m") {
        this.toggle()
      } else if (event.key === "Escape" && this.isOpen) {
        this.close()
      } else if (this.isOpen && /^[1-4]$/.test(event.key)) {
        this.setTab(TAB_ORDER[Number(event.key) - 1])
      }
    })
  }

  /** Called on every state poll (~150ms) — must not touch the DOM unless the module set actually changed. */
  setModules(modules: ModuleRef[]): void {
    this.modules = modules
    const signature = modules
      .map((m) => `${m.module_id}:${m.type}`)
      .sort()
      .join(",")
    if (signature === this.modulesSignature) return
    this.modulesSignature = signature
    if (this.isOpen) this.renderList()
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  open(): void {
    this.isOpen = true
    this.el.classList.remove("hidden")
    this.renderList()
  }

  close(): void {
    this.isOpen = false
    this.el.classList.add("hidden")
    this.stopRefresh()
  }

  private setTab(tab: ModuleTab): void {
    if (tab === this.activeTab) return
    this.activeTab = tab
    this.selectedModuleId = null
    this.stopRefresh()
    this.renderList()
  }

  private selectModule(moduleId: string): void {
    this.selectedModuleId = moduleId
    this.el.querySelectorAll<HTMLLIElement>("[data-module-id]").forEach((li) => {
      li.classList.toggle("active", li.dataset.moduleId === moduleId)
    })
    void this.showDetail(moduleId)
  }

  /** Rebuilds tabs + module list. Only called on open, tab switch, or a structural module change. */
  private renderList(): void {
    const tabsHtml = TAB_ORDER.map(
      (tab, i) => `<button class="modal-tab ${tab === this.activeTab ? "active" : ""}" data-tab="${tab}">
        ${i + 1}. ${TAB_LABELS[tab]}
      </button>`,
    ).join("")

    const modulesInTab = this.modules.filter((m) => tabForModuleType(m.type) === this.activeTab)
    const stillSelected = modulesInTab.some((m) => m.module_id === this.selectedModuleId)
    if (!stillSelected) this.selectedModuleId = null

    this.el.innerHTML = `
      <div class="modal-panel">
        <div class="modal-tabs">${tabsHtml}</div>
        <div class="modal-body" id="modal-body">
          ${modulesInTab.length === 0 ? "<p class=\"modal-empty\">Nessun modulo in questa categoria.</p>" : ""}
          <ul class="modal-module-list">
            ${modulesInTab
              .map(
                (m) =>
                  `<li data-module-id="${m.module_id}" class="${m.module_id === this.selectedModuleId ? "active" : ""}">${m.module_id} <span class="module-type">${m.type}</span></li>`,
              )
              .join("")}
          </ul>
          <div class="modal-detail" id="modal-detail"></div>
        </div>
      </div>
    `

    if (this.selectedModuleId) void this.showDetail(this.selectedModuleId)
  }

  private async showDetail(moduleId: string): Promise<void> {
    const detailEl = this.el.querySelector<HTMLDivElement>("#modal-detail")
    if (!detailEl) return
    this.stopRefresh()
    detailEl.innerHTML = "<p>Caricamento...</p>"
    try {
      const manifest = await ionClient.man(moduleId)
      if (this.selectedModuleId !== moduleId) return
      detailEl.innerHTML = renderManifest(manifest)
      this.bindManifestActions(detailEl, manifest)
      this.refreshTimer = window.setInterval(() => void this.refreshDetail(moduleId, detailEl), DETAIL_REFRESH_MS)
    } catch (err) {
      detailEl.innerHTML = `<p class="modal-error">${err instanceof Error ? err.message : "Errore"}</p>`
    }
  }

  /** Live-refresh, but only overwrite what the operator isn't actively editing: read-only fields and untouched inputs. */
  private async refreshDetail(moduleId: string, detailEl: HTMLDivElement): Promise<void> {
    if (this.selectedModuleId !== moduleId) return
    try {
      const manifest = await ionClient.man(moduleId)
      if (this.selectedModuleId !== moduleId) return

      const healthEl = detailEl.querySelector<HTMLElement>("[data-health-value]")
      if (healthEl) healthEl.textContent = `${manifest.health_pct.toFixed(0)}%`

      for (const v of manifest.variables) {
        const cargoEl = detailEl.querySelector<HTMLElement>(`[data-cargo-list="${v.name}"]`)
        if (cargoEl) {
          cargoEl.innerHTML = formatCargoSlots(v.value)
          continue
        }
        const valueEl = detailEl.querySelector<HTMLElement>(`[data-variable-value="${v.name}"]`)
        if (valueEl) {
          valueEl.textContent = formatVariableValue(v)
          continue
        }
        const input = detailEl.querySelector<HTMLInputElement>(`[data-variable="${v.name}"]`)
        if (input && document.activeElement !== input) {
          input.value = String(v.value ?? "")
        }
      }
    } catch (err) {
      console.error("Manifest refresh failed", err)
    }
  }

  private stopRefresh(): void {
    if (this.refreshTimer !== undefined) {
      window.clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  private bindManifestActions(detailEl: HTMLDivElement, manifest: ModuleManifest): void {
    detailEl.querySelectorAll<HTMLFormElement>("[data-action-form]").forEach((form) => {
      const actionName = form.dataset.actionForm!
      form.addEventListener("submit", (event) => {
        event.preventDefault()
        const params = Array.from(form.querySelectorAll<HTMLInputElement>("[data-param]")).map((input) => input.value)
        void ionClient.action(manifest.module_id, actionName, ...params)
      })
    })
    detailEl.querySelectorAll<HTMLInputElement>("[data-variable]").forEach((input) => {
      input.addEventListener("change", () => void ionClient.set(manifest.module_id, input.dataset.variable!, input.value))
    })
  }
}

// Cargo.slots serializes each Item as an externally-tagged Rust enum: {"Unit":["Iron",5]},
// {"Weight":["Iron",12.5]}, or {"Volume":["Iron",0.8]} — variant name plus a [item, amount] tuple.
function formatCargoItem(item: unknown): string {
  if (item && typeof item === "object") {
    const [variant, payload] = Object.entries(item as Record<string, unknown>)[0] ?? []
    if (Array.isArray(payload) && payload.length === 2) {
      const [name, amount] = payload as [string, number]
      const unit = variant === "Unit" ? "unità" : variant === "Weight" ? "kg" : variant === "Volume" ? "m³" : ""
      const formattedAmount = variant === "Unit" ? amount : Number(amount).toFixed(2)
      return `<li>${name}: ${formattedAmount} ${unit}</li>`
    }
  }
  return `<li>${JSON.stringify(item)}</li>`
}

function formatCargoSlots(slots: unknown): string {
  if (!Array.isArray(slots) || slots.length === 0) return `<p class="field-desc">Vuoto</p>`
  return `<ul class="cargo-list">${slots.map(formatCargoItem).join("")}</ul>`
}

function formatVariableValue(v: VariableManifest): string {
  if (v.value === null || v.value === undefined) return "-"
  if (typeof v.value === "number" && isSecondsField(v.name, v.description)) {
    return `${formatDuration(v.value)} (${v.value}s)`
  }
  return String(v.value)
}

function renderManifest(manifest: ModuleManifest): string {
  const variableRows = manifest.variables
    .map((v) => {
      if (v.type === "array") {
        return `<div class="manifest-row manifest-row-cargo">
          <label>${v.name} <span class="field-desc">${v.description}</span></label>
          <div data-cargo-list="${v.name}">${formatCargoSlots(v.value)}</div>
        </div>`
      }
      const control = v.mutable
        ? `<input data-variable="${v.name}" value="${v.value ?? ""}" />`
        : `<span class="field-value" data-variable-value="${v.name}">${formatVariableValue(v)}</span>`
      return `<div class="manifest-row">
        <label>${v.name} <span class="field-desc">${v.description}</span></label>
        ${control}
      </div>`
    })
    .join("")

  const actionRows = manifest.actions
    .map((a) => {
      const cooldownHint = a.cooldown_s > 0 ? ` (cooldown ${formatDuration(a.cooldown_s)})` : ""
      return `<form data-action-form="${a.name}" class="manifest-row manifest-action-row" title="${a.description}">
        <label>${a.name} <span class="field-desc">${a.description}${cooldownHint}</span></label>
        <span class="action-controls">
          ${a.params.map((p) => `<input data-param="${p.name}" placeholder="${p.name}" title="${p.description}" />`).join("")}
          <button type="submit">Esegui</button>
        </span>
      </form>`
    })
    .join("")

  return `
    <h3>${manifest.module_id} <span class="module-type">${manifest.type}</span></h3>
    <p>${manifest.description}</p>
    <div class="manifest-row">
      <label>Salute</label>
      <span class="field-value" data-health-value>${manifest.health_pct.toFixed(0)}%</span>
    </div>
    <div class="manifest-fields">
      ${variableRows}
      ${actionRows}
    </div>
  `
}
