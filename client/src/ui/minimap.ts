import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

const SCAN_RANGE_M = 9.4607e15 // 1 ly — matches SystemMap.scan's radius
const SIZE_PX = 160

export class Minimap {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas")
    this.canvas.width = SIZE_PX
    this.canvas.height = SIZE_PX
    this.canvas.className = "minimap"
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext("2d")!
  }

  update(shipPosition: FloatingOriginPosition, entries: SystemMapEntry[]): void {
    const ctx = this.ctx
    const center = SIZE_PX / 2
    const maxRadius = center - 8

    ctx.clearRect(0, 0, SIZE_PX, SIZE_PX)

    ctx.strokeStyle = "#333"
    ctx.beginPath()
    ctx.arc(center, center, maxRadius, 0, Math.PI * 2)
    ctx.stroke()

    for (const entry of entries) {
      const [dx, , dz] = relativeVector(shipPosition, entry.position)
      const distance = Math.hypot(dx, dz)
      const radius = Math.min(1, distance / SCAN_RANGE_M) * maxRadius
      const angle = Math.atan2(dz, dx)

      ctx.fillStyle = entry.kind === "star" ? "#ffdd66" : "#6699cc"
      ctx.beginPath()
      ctx.arc(center + Math.cos(angle) * radius, center + Math.sin(angle) * radius, entry.kind === "star" ? 3 : 2, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = "#6cf"
    ctx.beginPath()
    ctx.arc(center, center, 3, 0, Math.PI * 2)
    ctx.fill()
  }
}
