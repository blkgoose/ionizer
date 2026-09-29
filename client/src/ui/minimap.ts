import * as THREE from "three"
import type { FloatingOriginPosition, RadarContactEntry, SystemMapEntry } from "../api/types"
import { relativeVector, type OrientationQuaternion } from "../state/shipState"

// radar.rs's RADAR_SCAN_DISTANCE — nearby ships/asteroids inside this range are placed at their
// real (scaled) distance from center; SystemMap stars/planets are light-years away and always
// pinned to the rim instead (only their direction matters at that scale).
const RADAR_RANGE_M = 10e3
const SIZE_PX = 160

// Ship-local convention (see the main engine/SteeringThruster): local +X is forward, local +Y is
// lateral (yaw 90/270 mounts). Rotating every relative position into this frame before projecting
// means "up" on the disc is always where the ship is currently pointed, not a fixed world axis.
function toLocalFrame(orientation: OrientationQuaternion, dx: number, dy: number, dz: number): THREE.Vector3 {
  const inverseOrientation = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.q).invert()
  return new THREE.Vector3(dx, dy, dz).applyQuaternion(inverseOrientation)
}

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

  update(
    shipPosition: FloatingOriginPosition,
    orientation: OrientationQuaternion | null,
    systemEntries: SystemMapEntry[],
    radarContacts: RadarContactEntry[],
  ): void {
    const ctx = this.ctx
    const center = SIZE_PX / 2
    const maxRadius = center - 8

    ctx.clearRect(0, 0, SIZE_PX, SIZE_PX)

    ctx.strokeStyle = "#333"
    ctx.beginPath()
    ctx.arc(center, center, maxRadius, 0, Math.PI * 2)
    ctx.stroke()

    if (!orientation) {
      // No attitude data yet — draw the ship dot only, nothing to meaningfully rotate against.
      ctx.fillStyle = "#6cf"
      ctx.beginPath()
      ctx.arc(center, center, 3, 0, Math.PI * 2)
      ctx.fill()
      return
    }

    const plot = (dx: number, dy: number, dz: number, pinToRim: boolean, color: string, radius: number) => {
      const local = toLocalFrame(orientation, dx, dy, dz)
      const distance = Math.hypot(local.x, local.y)
      if (distance === 0) return

      let screenRadius = pinToRim ? maxRadius : Math.min(1, distance / RADAR_RANGE_M) * maxRadius
      const scale = screenRadius / distance
      const screenX = center + local.y * scale
      const screenY = center - local.x * scale

      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(screenX, screenY, radius, 0, Math.PI * 2)
      ctx.fill()
    }

    for (const [, position] of radarContacts) {
      const [dx, dy, dz] = relativeVector(shipPosition, position)
      plot(dx, dy, dz, false, "#cc5555", 3)
    }

    for (const entry of systemEntries) {
      const [dx, dy, dz] = relativeVector(shipPosition, entry.position)
      plot(dx, dy, dz, true, entry.kind === "star" ? "#ffdd66" : "#6699cc", entry.kind === "star" ? 3 : 2)
    }

    // Ship marker: a triangle pointing "up" — up is always forward by construction above.
    ctx.fillStyle = "#6cf"
    ctx.beginPath()
    ctx.moveTo(center, center - 6)
    ctx.lineTo(center - 4, center + 4)
    ctx.lineTo(center + 4, center + 4)
    ctx.closePath()
    ctx.fill()
  }
}
