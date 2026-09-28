import * as THREE from "three"
import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

// Real distances are light-years; nothing renders sensibly at true scale. Stars/planets are
// placed at a fixed distance along their real direction from the ship instead — a skybox, not a
// to-scale model. Kept comfortably past the tactical camera's max orbit distance (see
// tacticalCamera.ts's MAX_DISTANCE) so they stay "outside" the scene at any zoom level instead of
// the camera ever ending up further from the ship than the skybox itself. Rebuilt wholesale on
// every call: SystemMap entries have no stable id to diff against, and there are only ever a
// handful within the 1 ly scan radius.
const SKY_RADIUS_M = 30000
const STAR_VISUAL_RADIUS_M = 500
const PLANET_VISUAL_RADIUS_M = 200

export interface StarfieldPickable {
  entryIndex: number // index into the SystemMapEntry[] this was last built from — see systemMapPoller.getLatest()
  kind: string
  object: THREE.Object3D
  position: THREE.Vector3 // the skybox point actually rendered — for on-screen labels to line up exactly with the 3D dot
  distanceM: number // ship-to-real-entry distance (not to the skybox point, which is a stylized stand-in)
}

export class Starfield {
  private group = new THREE.Group()
  private light = new THREE.DirectionalLight(0xfff4e6, 0)
  private lightTarget = new THREE.Object3D()
  private pickables: StarfieldPickable[] = []

  constructor(scene: THREE.Scene) {
    scene.add(this.group)
    scene.add(this.lightTarget)
    this.light.target = this.lightTarget
    scene.add(this.light)
  }

  /**
   * `shipWorldPosition` (not the camera's) anchors the skybox — in cockpit mode the camera sits
   * on the ship anyway so this changes nothing, but in tactical mode the camera roams far from
   * the ship, and anchoring to the camera used to make every star/planet swim around and
   * teleport as the tactical camera panned/zoomed, which also broke clicking them.
   */
  update(shipWorldPosition: [number, number, number], shipPosition: FloatingOriginPosition, entries: SystemMapEntry[]): void {
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0])
    }

    const anchor = new THREE.Vector3(...shipWorldPosition)
    this.pickables = []
    let nearestStarDir: THREE.Vector3 | null = null
    let nearestStarDistance = Infinity

    for (const [entryIndex, entry] of entries.entries()) {
      const [dx, dy, dz] = relativeVector(shipPosition, entry.position)
      const distance = Math.hypot(dx, dy, dz)
      if (distance === 0) continue
      const direction = new THREE.Vector3(dx, dy, dz).normalize()

      const isStar = entry.kind === "star"
      const visualRadius = isStar ? STAR_VISUAL_RADIUS_M : PLANET_VISUAL_RADIUS_M
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius, 12, 8),
        isStar
          ? new THREE.MeshBasicMaterial({ color: 0xfff4c2 })
          : new THREE.MeshLambertMaterial({ color: 0x6699cc, flatShading: true }),
      )
      mesh.position.copy(anchor).addScaledVector(direction, SKY_RADIUS_M * (isStar ? 1 : 0.85))
      this.group.add(mesh)

      // Invisible, oversized hit-target: the visual body is deliberately small (a stylized
      // skybox dot, not to-scale), too small to reliably click — material.visible = false skips
      // rendering but three.js's raycaster still tests the geometry.
      const hitTarget = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius * 1.6, 8, 6),
        new THREE.MeshBasicMaterial({ visible: false }),
      )
      hitTarget.position.copy(mesh.position)
      this.group.add(hitTarget)
      this.pickables.push({ entryIndex, kind: entry.kind, object: hitTarget, position: mesh.position.clone(), distanceM: distance })

      if (isStar && distance < nearestStarDistance) {
        nearestStarDistance = distance
        nearestStarDir = direction
      }
    }

    if (nearestStarDir) {
      this.light.position.copy(anchor).addScaledVector(nearestStarDir, 100)
      this.lightTarget.position.copy(anchor)
      this.light.intensity = 1.4
    } else {
      this.light.intensity = 0
    }
  }

  /** For tactical-mode raycasting and on-screen labels. Valid only against the SystemMapEntry[] passed to the last update(). */
  getPickables(): StarfieldPickable[] {
    return this.pickables
  }
}
