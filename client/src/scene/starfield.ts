import * as THREE from "three"
import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

// SystemMap's scan radius is 1 ly (system_map.rs), so most entries — every star other than the
// one in the ship's own system, plus that star's own farther-out planets — are genuinely
// light-years away and can't render sensibly at true scale. Those still get placed at a fixed
// distance along their real direction from the ship instead — a skybox, not a to-scale model.
// Kept comfortably past the tactical camera's max orbit distance (see tacticalCamera.ts's
// MAX_DISTANCE) so they stay "outside" the scene at any zoom level instead of the camera ever
// ending up further from the ship than the skybox itself.
//
// Anything within NEAR_RENDER_THRESHOLD_M, though — e.g. the planet a "bodyApproach" autopilot
// goal is actually flying towards — is rendered at its real position and real size instead, same
// as radar contacts (scene.ts). Without this split, a 131,000km-diameter planet the ship is
// arriving at (autopilot correctly braking, essentially touching the surface) still only ever
// showed as a distant skybox dot, because it was never given a real to-scale position at all.
//
// Rebuilt wholesale on every call: SystemMap entries have no stable id to diff against, and there
// are only ever a handful within the 1 ly scan radius.
const SKY_RADIUS_M = 30000
const STAR_VISUAL_RADIUS_M = 500
const PLANET_VISUAL_RADIUS_M = 200

// galaxy.rs caps planet orbits at 40 AU (~6e12 m) — comfortably past this, a body is either a
// neighboring system's star or one of its far-out planets, not something reachable this session.
// scene.ts's camera far plane and logarithmic depth buffer are sized to match this threshold.
export const NEAR_RENDER_THRESHOLD_M = 2e9

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
      const isNear = distance <= NEAR_RENDER_THRESHOLD_M

      let mesh: THREE.Mesh
      let hitTargetRadius: number
      if (isNear) {
        // Real position, real size — same treatment as radar contacts (scene.ts), just without a
        // heading cone (bodies don't have one to show).
        //
        // DoubleSide matters here specifically: "arrived" only requires distance-to-*surface* to
        // reach the arrival radius (autopilot.ts), and distance-to-*center* (used for isNear/the
        // real position above) can already be smaller than the body's own radius by then — i.e.
        // the ship/camera ends up inside the sphere's geometry. Three.js's default FrontSide
        // culls every face as seen from inside a convex shell (nothing left facing the camera),
        // making the whole sphere both invisible and unraycastable — exactly "doesn't render,
        // isn't clickable" — the moment you get that close.
        const realRadius = Math.max(1, entry.diameter_m / 2)
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(realRadius, 32, 24),
          isStar
            ? new THREE.MeshBasicMaterial({ color: 0xfff4c2, side: THREE.DoubleSide })
            : new THREE.MeshLambertMaterial({ color: 0x6699cc, flatShading: true, side: THREE.DoubleSide }),
        )
        mesh.position.copy(anchor).addScaledVector(direction, distance)
        // The real body is already easy to click (often filling much of the screen up close);
        // only pad a little, unlike the skybox dots below.
        hitTargetRadius = realRadius * 1.1
      } else {
        const visualRadius = isStar ? STAR_VISUAL_RADIUS_M : PLANET_VISUAL_RADIUS_M
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(visualRadius, 12, 8),
          isStar
            ? new THREE.MeshBasicMaterial({ color: 0xfff4c2, depthWrite: false })
            : new THREE.MeshLambertMaterial({ color: 0x6699cc, flatShading: true, depthWrite: false }),
        )
        // A fixed, arbitrarily-close stand-in distance (SKY_RADIUS_M, 30km) for something that's
        // actually light-years away — real depth-testing would otherwise let this dot win against
        // any true-to-scale near body still farther than 30km out (i.e. most of an approach), even
        // though it should never occlude a real object. depthWrite:false + a low renderOrder is
        // the standard skybox trick: this draws first and leaves no depth value behind, so
        // whatever's drawn afterwards (any real scene geometry, regardless of its own true depth)
        // always wins.
        mesh.renderOrder = -1
        mesh.position.copy(anchor).addScaledVector(direction, SKY_RADIUS_M * (isStar ? 1 : 0.85))
        // Deliberately oversized hit-target: the visual body is a stylized skybox dot, not
        // to-scale, too small to reliably click — material.visible = false skips rendering but
        // three.js's raycaster still tests the geometry.
        hitTargetRadius = visualRadius * 1.6
      }
      this.group.add(mesh)

      const hitTarget = new THREE.Mesh(
        new THREE.SphereGeometry(hitTargetRadius, 8, 6),
        // DoubleSide here too — the invisible hit-target sphere needs to stay raycastable even
        // when the camera ends up inside it (see the near-body DoubleSide comment above).
        new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
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
