import * as THREE from "three"

const LIGHT_YEAR_M = 9.4607e15
const AU_M = 1.496e11
const EDGE_MARGIN = 0.92 // keep off-screen markers just inside the viewport edge, in NDC units

function formatDistance(distanceM: number): string {
  if (distanceM < AU_M * 0.01) return `${(distanceM / 1000).toFixed(0)} km`
  if (distanceM < LIGHT_YEAR_M * 0.1) return `${(distanceM / AU_M).toFixed(2)} AU`
  return `${(distanceM / LIGHT_YEAR_M).toFixed(2)} ly`
}

export interface DirectionMarkerEntry {
  icon: string
  /** The exact point rendered in the 3D scene (Starfield's skybox dot, or a contact's real position) — projecting this instead of an independently-derived direction keeps the label glued to the object it's labeling. */
  worldPosition: THREE.Vector3
  /** Real ship-to-entity distance — not the distance to `worldPosition`, which for skybox bodies is a stylized stand-in. */
  distanceM: number
}

/**
 * HUD compass markers: shows where system-map bodies and radar contacts actually are relative to
 * the ship even when they're too far/small/out of frame to read at a glance in the 3D scene
 * itself. On-screen entries get a label at their real projected position; off-screen ones get an
 * arrow clamped to the edge of the view, pointing the way to turn.
 */
export class DirectionMarkers {
  private el: HTMLDivElement

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "direction-markers"
    container.appendChild(this.el)
  }

  update(camera: THREE.PerspectiveCamera, entries: DirectionMarkerEntry[]): void {
    const markers = entries.map(({ icon, worldPosition, distanceM }) => {
      const ndc = worldPosition.clone().project(camera)

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

      return { icon, distanceM, left, top, offscreen, angleDeg }
    })

    this.el.innerHTML = markers
      .map(({ icon, distanceM, left, top, offscreen, angleDeg }) => {
        const arrow = offscreen ? `<span class="direction-arrow" style="transform: rotate(${angleDeg}deg)">▲</span>` : ""
        return `<div class="direction-marker${offscreen ? " offscreen" : ""}" style="left:${left}px; top:${top}px">
          ${arrow}<span>${icon} ${formatDistance(distanceM)}</span>
        </div>`
      })
      .join("")
  }
}
