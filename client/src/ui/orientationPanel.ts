import { OrientationWidget } from "../scene/orientationWidget"
import { FUEL_CAPACITY_KG, type EngineActivation, type FuelLevel, type OrientationQuaternion } from "../state/shipState"

export class OrientationPanel {
  private widget = new OrientationWidget()
  private gaugeEl: HTMLDivElement
  private fuelEl: HTMLDivElement

  constructor(container: HTMLElement) {
    const root = document.createElement("div")
    root.className = "orientation-panel"

    const canvasWrap = document.createElement("div")
    canvasWrap.className = "orientation-canvas"
    canvasWrap.appendChild(this.widget.domElement)

    const gaugesColumn = document.createElement("div")
    gaugesColumn.className = "gauges-column"

    this.gaugeEl = document.createElement("div")
    this.gaugeEl.className = "engine-gauge"

    this.fuelEl = document.createElement("div")
    this.fuelEl.className = "engine-gauge fuel-gauge"

    gaugesColumn.append(this.gaugeEl, this.fuelEl)
    root.append(canvasWrap, gaugesColumn)
    container.appendChild(root)
  }

  update(orientation: OrientationQuaternion | null, engines: EngineActivation[], fuels: FuelLevel[]): void {
    this.widget.update(orientation)

    this.gaugeEl.innerHTML = engines
      .map(
        (e) => `<div class="engine-bar">
          <span>${e.type} <b>${e.activation.toFixed(0)}%</b></span>
          <div class="bar"><div class="bar-fill" style="width:${e.activation}%"></div></div>
        </div>`,
      )
      .join("")

    this.fuelEl.innerHTML = fuels
      .map((f) => {
        const pct = (f.fuelKg / FUEL_CAPACITY_KG) * 100
        return `<div class="engine-bar">
          <span>Fuel <b>${f.fuelKg.toFixed(0)} kg</b></span>
          <div class="bar"><div class="bar-fill fuel-fill" style="width:${pct}%"></div></div>
        </div>`
      })
      .join("")
  }
}
