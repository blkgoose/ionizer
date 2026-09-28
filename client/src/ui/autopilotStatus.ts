import type { AutopilotPhase } from "../scene/autopilot"

const PHASE_LABELS: Record<AutopilotPhase, string> = {
  idle: "",
  tuning: "Calibrazione RCS…",
  pointing: "Puntamento",
  burning: "Accelerazione",
  stoppingBurner: "Arresto propulsore",
  reverse: "Inversione di rotta",
  stopping: "Frenata",
  fineStop: "Frenata di precisione",
}

export class AutopilotStatus {
  private el: HTMLDivElement
  private textEl: HTMLSpanElement
  private disengageButton: HTMLButtonElement

  constructor(container: HTMLElement, onDisengage: () => void) {
    this.el = document.createElement("div")
    this.el.className = "autopilot-status hidden"
    this.el.innerHTML = `<span class="autopilot-status-text"></span><button type="button">Disengage</button>`
    container.appendChild(this.el)

    this.textEl = this.el.querySelector("span")!
    this.disengageButton = this.el.querySelector("button")!
    this.disengageButton.addEventListener("click", onDisengage)
  }

  update(engaged: boolean, label: string, phase: AutopilotPhase): void {
    this.el.classList.toggle("hidden", !engaged)
    if (!engaged) return
    this.textEl.textContent = `${label} — ${PHASE_LABELS[phase]}`
  }
}
