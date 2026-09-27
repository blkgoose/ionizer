import type { ShipEntity, Vector3 } from "../api/types"
import { readAngularVelocity, readPosition, readVelocity } from "../state/shipState"

const RAD_TO_DEG = 180 / Math.PI

export class Hud {
  private positionEl: HTMLDivElement
  private velocityEl: HTMLDivElement
  private accelerationEl: HTMLDivElement
  private angularVelocityEl: HTMLDivElement
  private lastVelocity: Vector3 | null = null
  private lastTimestamp: number | null = null

  constructor(container: HTMLElement, onLogout: () => void) {
    const el = document.createElement("div")
    el.className = "hud"

    const statusPanel = document.createElement("div")
    statusPanel.className = "hud-panel hud-status"

    this.positionEl = document.createElement("div")
    this.velocityEl = document.createElement("div")
    this.accelerationEl = document.createElement("div")
    this.angularVelocityEl = document.createElement("div")
    statusPanel.append(this.positionEl, this.velocityEl, this.accelerationEl, this.angularVelocityEl)
    el.appendChild(statusPanel)

    const hint = document.createElement("div")
    hint.className = "hud-panel hud-hint"
    hint.textContent = "[M] Moduli"
    el.appendChild(hint)

    const logoutBtn = document.createElement("button")
    logoutBtn.className = "hud-panel hud-logout"
    logoutBtn.textContent = "Logout"
    logoutBtn.style.pointerEvents = "auto"
    logoutBtn.addEventListener("click", onLogout)
    el.appendChild(logoutBtn)

    container.appendChild(el)
  }

  update(entity: ShipEntity): void {
    const [x, y, z] = readPosition(entity)
    this.positionEl.textContent = `POS ${x.toFixed(4)} / ${y.toFixed(4)} / ${z.toFixed(4)}`

    const velocity = readVelocity(entity)
    const now = performance.now()
    if (!velocity) return

    this.velocityEl.textContent = `VEL ${velocity.x.toFixed(4)} / ${velocity.y.toFixed(4)} / ${velocity.z.toFixed(4)} m/s`

    if (this.lastVelocity && this.lastTimestamp !== null) {
      const dt = (now - this.lastTimestamp) / 1000
      if (dt > 0) {
        const ax = (velocity.x - this.lastVelocity.x) / dt
        const ay = (velocity.y - this.lastVelocity.y) / dt
        const az = (velocity.z - this.lastVelocity.z) / dt
        this.accelerationEl.textContent = `ACC ${ax.toFixed(4)} / ${ay.toFixed(4)} / ${az.toFixed(4)} m/s²`
      }
    }

    this.lastVelocity = velocity
    this.lastTimestamp = now

    const angularVelocity = readAngularVelocity(entity)
    if (angularVelocity) {
      const wx = angularVelocity.x * RAD_TO_DEG
      const wy = angularVelocity.y * RAD_TO_DEG
      const wz = angularVelocity.z * RAD_TO_DEG
      this.angularVelocityEl.textContent = `ANG ${wx.toFixed(4)} / ${wy.toFixed(4)} / ${wz.toFixed(4)} deg/s`
    }
  }
}
