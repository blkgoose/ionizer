import * as THREE from "three"
import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

const LIGHT_YEAR_M = 9.4607e15
const AU_M = 1.496e11
const PROBE_DISTANCE = 1000 // arbitrary point far along the real direction, just for projection
const EDGE_MARGIN = 0.92 // keep off-screen markers just inside the viewport edge, in NDC units

function formatDistance(distanceM: number): string {
  if (distanceM < AU_M * 0.01) return `${(distanceM / 1000).toFixed(0)} km`
  if (distanceM < LIGHT_YEAR_M * 0.1) return `${(distanceM / AU_M).toFixed(2)} AU`
  return `${(distanceM / LIGHT_YEAR_M).toFixed(2)} ly`
}

/**
 * HUD compass markers for stars/planets the SystemMap knows about: shows where they actually are
 * relative to the ship even when they're too far/out of frame to render in the 3D scene itself
 * (Starfield only draws a skybox dot, which is easy to miss and gives no sense of direction).
 * On-screen entries get a label at their real projected position; off-screen ones get an arrow
 * clamped to the edge of the view, pointing the way to turn.
 */
export class DirectionMarkers {
  private el: HTMLDivElement

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "direction-markers"
    container.appendChild(this.el)
  }

  update(
    camera: THREE.PerspectiveCamera,
    shipPosition: FloatingOriginPosition,
    entries: SystemMapEntry[],
  ): void {
    const markers = entries.map((entry) => {
      const [dx, dy, dz] = relativeVector(shipPosition, entry.position)
      const distance = Math.hypot(dx, dy, dz)
      const direction = new THREE.Vector3(dx, dy, dz).normalize()
      const point = camera.position.clone().addScaledVector(direction, PROBE_DISTANCE)
      const ndc = point.project(camera)

      const behind = ndc.z > 1
      let x = behind ? -ndc.x : ndc.x
      let y = behind ? -ndc.y : ndc.y
      const offscreen = behind || x < -1 || x > 1 || y < -1 || y > 1

      if (offscreen) {
        const angle = Math.atan2(y, x)
        x = Math.cos(angle) * EDGE_MARGIN
        y = Math.sin(angle) * EDGE_MARGIN
      }

      const left = (x * 0.5 + 0.5) * window.innerWidth
      const top = (1 - (y * 0.5 + 0.5)) * window.innerHeight
      const angleDeg = offscreen ? (Math.atan2(-y, x) * 180) / Math.PI : null

      return { entry, distance, left, top, offscreen, angleDeg }
    })

    this.el.innerHTML = markers
      .map(({ entry, distance, left, top, offscreen, angleDeg }) => {
        const icon = entry.kind === "star" ? "☉" : "●"
        const arrow = offscreen ? `<span class="direction-arrow" style="transform: rotate(${angleDeg}deg)">▲</span>` : ""
        return `<div class="direction-marker${offscreen ? " offscreen" : ""}" style="left:${left}px; top:${top}px">
          ${arrow}<span>${icon} ${formatDistance(distance)}</span>
        </div>`
      })
      .join("")
  }
}
