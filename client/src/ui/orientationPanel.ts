import { OrientationWidget } from "../scene/orientationWidget"
import type { EngineActivation, OrientationQuaternion } from "../state/shipState"

export class OrientationPanel {
  private widget = new OrientationWidget()
  private gaugeEl: HTMLDivElement

  constructor(container: HTMLElement) {
    const root = document.createElement("div")
    root.className = "orientation-panel"

    const canvasWrap = document.createElement("div")
    canvasWrap.className = "orientation-canvas"
    canvasWrap.appendChild(this.widget.domElement)

    this.gaugeEl = document.createElement("div")
    this.gaugeEl.className = "engine-gauge"

    root.append(canvasWrap, this.gaugeEl)
    container.appendChild(root)
  }

  update(orientation: OrientationQuaternion | null, engines: EngineActivation[]): void {
    this.widget.update(orientation)

    this.gaugeEl.innerHTML = engines
      .map(
        (e) => `<div class="engine-bar">
          <span>${e.type} <b>${e.activation.toFixed(0)}%</b></span>
          <div class="bar"><div class="bar-fill" style="width:${e.activation}%"></div></div>
        </div>`,
      )
      .join("")
  }
}
