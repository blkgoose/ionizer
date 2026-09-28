import * as THREE from "three"
import type { OrientationQuaternion } from "../state/shipState"
import { OrientationCage } from "./orientationCage"
import { NEAR_RENDER_THRESHOLD_M } from "./starfield"

// Ship-local "forward" is +X (see FixedThruster: force applied along local (1,0,0), then rotated
// by body orientation) but three.js's camera looks down its local -Z by default. This fixed
// rotation (-90 deg about Y) reconciles the two spaces before the ship's real orientation quaternion
// is applied, so the cockpit view actually turns to match the ship's real attitude instead of
// only ever looking along world -Z.
const CAMERA_TO_SHIP_SPACE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2)

export interface RadarContact {
  entityId: string
  position: [number, number, number]
  size: number // radar.rs's Radar.scan reports this as the contact's diameter, in meters
}

/**
 * Ships are spheres at heart (that's their actual collision/size envelope), which is hard to
 * judge from a heading cone alone — so every ship (ours and contacts) renders as a faint,
 * translucent sphere at its true radius, with a solid cone inside pointing along local forward
 * (+X) as a heading indicator. `radius` is in whatever unit space the caller scales/positions in
 * (real meters for radar contacts; a unit sphere scaled up to size for the own-ship mesh).
 */
function buildShipVisual(radius: number, color: number): THREE.Group {
  const hull = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }),
  )
  // Base radius == sphere radius, height == sphere radius: after the rotation+offset below this
  // is the largest cone (apex at the sphere's front pole, base rim on its equator) that stays
  // fully inside the hull at every point along its length — a bigger base or taller cone would
  // poke its base corners out through the surface.
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(radius, radius, 8),
    new THREE.MeshLambertMaterial({ color, flatShading: true }),
  )
  cone.rotation.z = -Math.PI / 2
  cone.position.x = radius / 2
  // Rear half: a solid hemisphere filling the other side of the hull (from the equator back to
  // the rear pole), so cone + hemisphere together fill the whole sphere silhouette like a bullet.
  // SphereGeometry's theta range (0..PI/2) gives a dome from its pole down to the equator, with
  // the equator plane sitting at the mesh's own local origin — rotating +90° about Z (opposite
  // sign from the cone above) swings that pole to -X, matching the cone's flat base at x=0.
  const rear = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshLambertMaterial({ color, flatShading: true }),
  )
  rear.rotation.z = Math.PI / 2
  const group = new THREE.Group()
  group.add(hull, cone, rear)
  return group
}

export class FlightScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private contacts = new Map<string, THREE.Object3D>()
  private orientationCage: OrientationCage
  private ownShip: THREE.Object3D

  constructor(container: HTMLElement) {
    // Regular (linear) depth buffers only have enough precision for a few orders of magnitude
    // between near/far — fine when the far plane was 100km (ships only), but starfield.ts now
    // renders near planets at their true, sometimes 2,000,000km-away position too. Logarithmic
    // depth solves that without needing a tighter near plane (which would clip the cockpit view).
    this.renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    container.appendChild(this.renderer.domElement)

    // Far plane padded past NEAR_RENDER_THRESHOLD_M so a body doesn't get clipped right at the
    // real-vs-skybox cutover — see starfield.ts.
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, NEAR_RENDER_THRESHOLD_M * 1.5)

    // Low fill light only — the real "sun" now comes from Starfield, driven by whatever
    // star the SystemMap scan actually finds nearby, so lighting reflects where we are.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15))

    this.orientationCage = new OrientationCage(this.scene)

    // We ARE the camera in cockpit mode, so this only needs to be visible in tactical mode
    // (see setOwnShipVisible) — otherwise it'd just render inside the camera's own origin point.
    this.ownShip = this.buildOwnShipMesh()
    this.ownShip.visible = false
    this.scene.add(this.ownShip)

    window.addEventListener("resize", () => this.onResize())
  }

  private buildOwnShipMesh(): THREE.Object3D {
    // Unit sphere+cone (radius 0.5, i.e. diameter 1) pointing along ship-local forward (+X);
    // uniformly scaled to the real size reported by GET (see setOwnShipSize) so it's not just an
    // arbitrarily-sized placeholder.
    return buildShipVisual(0.5, 0x66ccff)
  }

  setOwnShipVisible(visible: boolean): void {
    this.ownShip.visible = visible
  }

  setOwnShipTransform(position: [number, number, number], orientation: OrientationQuaternion | null): void {
    this.ownShip.position.set(...position)
    if (orientation) this.ownShip.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.q)
  }

  /** `sizeM` is the ship's real diameter, as reported by GET's body.size. */
  setOwnShipSize(sizeM: number): void {
    this.ownShip.scale.setScalar(Math.max(0.1, sizeM))
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  get cameraPosition(): THREE.Vector3 {
    return this.camera.position
  }

  setCockpitPosition(position: [number, number, number]): void {
    this.camera.position.set(...position)
  }

  /** Turns the cockpit view to match the ship's real attitude (see CAMERA_TO_SHIP_SPACE above). */
  setOrientation(orientation: OrientationQuaternion | null): void {
    if (!orientation) return
    const shipQuat = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.q)
    this.camera.quaternion.multiplyQuaternions(shipQuat, CAMERA_TO_SHIP_SPACE)
  }

  syncContacts(contacts: RadarContact[]): void {
    const seen = new Set<string>()
    for (const contact of contacts) {
      seen.add(contact.entityId)
      let group = this.contacts.get(contact.entityId)
      if (!group) {
        // No orientation data comes back from Radar.scan (just position + size) — the forward
        // cone is pinned to a fixed local +X regardless, purely as a scale/reference marker, not
        // a real heading indicator.
        const radius = Math.max(1, contact.size / 2)
        const visual = buildShipVisual(radius, 0xcc3333)
        // Invisible, oversized hit-target: the visual body can be too small on screen (especially
        // at tactical-camera zoom) to reliably click — material.visible = false skips rendering
        // but three.js's raycaster still tests the geometry.
        const hitTarget = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(30, radius * 4), 6, 6),
          new THREE.MeshBasicMaterial({ visible: false }),
        )
        group = new THREE.Group()
        group.add(visual, hitTarget)
        this.scene.add(group)
        this.contacts.set(contact.entityId, group)
      }
      group.position.set(...contact.position)
    }

    for (const [id, mesh] of this.contacts) {
      if (!seen.has(id)) {
        this.scene.remove(mesh)
        this.contacts.delete(id)
      }
    }
  }

  /** For tactical-mode raycasting: each live radar contact's clickable object, tagged by entity id. */
  getContactPickables(): { entityId: string; object: THREE.Object3D }[] {
    return Array.from(this.contacts, ([entityId, object]) => ({ entityId, object }))
  }

  render(): void {
    this.orientationCage.syncTo(this.camera.position)
    this.renderer.render(this.scene, this.camera)
  }
}
