import type { ShipEntity, Vector3 } from "../api/types"
import { readAngularVelocity, readPosition, readVelocity } from "../state/shipState"

const RAD_TO_DEG = 180 / Math.PI

interface StatusLine {
  root: HTMLDivElement
  x: HTMLSpanElement
  y: HTMLSpanElement
  z: HTMLSpanElement
}

// Numbers rebuilt via textContent (never innerHTML) into fixed-width spans (see .hud-num in
// style.css): position/velocity/acceleration change every frame, and re-laying-out variable-width
// text each time made the whole panel visibly jitter as digits/sign changed.
function buildLine(label: string, unit: string): StatusLine {
  const root = document.createElement("div")
  const x = document.createElement("span")
  const y = document.createElement("span")
  const z = document.createElement("span")
  x.className = y.className = z.className = "hud-num"
  root.append(`${label} `, x, " / ", y, " / ", z, unit ? ` ${unit}` : "")
  return { root, x, y, z }
}

function setLine(line: StatusLine, x: number, y: number, z: number): void {
  line.x.textContent = x.toFixed(4)
  line.y.textContent = y.toFixed(4)
  line.z.textContent = z.toFixed(4)
}

export class Hud {
  private positionLine: StatusLine
  private velocityLine: StatusLine
  private accelerationLine: StatusLine
  private angularVelocityLine: StatusLine
  private lastVelocity: Vector3 | null = null
  private lastTimestamp: number | null = null

  constructor(container: HTMLElement, onLogout: () => void, onFullStop: () => void) {
    const el = document.createElement("div")
    el.className = "hud"

    const statusPanel = document.createElement("div")
    statusPanel.className = "hud-panel hud-status"

    this.positionLine = buildLine("POS", "")
    this.velocityLine = buildLine("VEL", "m/s")
    this.accelerationLine = buildLine("ACC", "m/s²")
    this.angularVelocityLine = buildLine("ANG", "deg/s")
    statusPanel.append(
      this.positionLine.root,
      this.velocityLine.root,
      this.accelerationLine.root,
      this.angularVelocityLine.root,
    )
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

    const fullStopBtn = document.createElement("button")
    fullStopBtn.className = "hud-panel hud-full-stop"
    fullStopBtn.textContent = "Full stop"
    fullStopBtn.style.pointerEvents = "auto"
    fullStopBtn.addEventListener("click", onFullStop)
    el.appendChild(fullStopBtn)

    container.appendChild(el)
  }

  update(entity: ShipEntity): void {
    const [x, y, z] = readPosition(entity)
    setLine(this.positionLine, x, y, z)

    const velocity = readVelocity(entity)
    const now = performance.now()
    if (!velocity) return

    setLine(this.velocityLine, velocity.x, velocity.y, velocity.z)

    if (this.lastVelocity && this.lastTimestamp !== null) {
      const dt = (now - this.lastTimestamp) / 1000
      if (dt > 0) {
        const ax = (velocity.x - this.lastVelocity.x) / dt
        const ay = (velocity.y - this.lastVelocity.y) / dt
        const az = (velocity.z - this.lastVelocity.z) / dt
        setLine(this.accelerationLine, ax, ay, az)
      }
    }

    this.lastVelocity = velocity
    this.lastTimestamp = now

    const angularVelocity = readAngularVelocity(entity)
    if (angularVelocity) {
      setLine(
        this.angularVelocityLine,
        angularVelocity.x * RAD_TO_DEG,
        angularVelocity.y * RAD_TO_DEG,
        angularVelocity.z * RAD_TO_DEG,
      )
    }
  }
}
