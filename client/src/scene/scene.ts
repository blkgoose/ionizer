import * as THREE from "three"
import type { OrientationQuaternion } from "../state/shipState"
import { OrientationCage } from "./orientationCage"

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

export class FlightScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private contacts = new Map<string, THREE.Object3D>()
  private orientationCage: OrientationCage
  private ownShip: THREE.Object3D

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000)

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
    // Unit cone (diameter 1, height 1) pointing along +Y by default; rotated so it points along
    // ship-local forward (+X), then uniformly scaled to the real size reported by GET (see
    // setOwnShipSize) so it's not just an arbitrarily-sized placeholder.
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1, 8),
      new THREE.MeshLambertMaterial({ color: 0x66ccff, flatShading: true }),
    )
    body.rotation.z = -Math.PI / 2
    const group = new THREE.Group()
    group.add(body)
    return group
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
        // No orientation data comes back from Radar.scan (just position + size) — the white dot
        // is pinned to a fixed local +X regardless, purely as a scale/reference marker, not a
        // real heading indicator.
        const radius = Math.max(1, contact.size / 2)
        const body = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 12, 8),
          new THREE.MeshLambertMaterial({ color: 0xcc3333, flatShading: true }),
        )
        const tip = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(0.5, radius * 0.12), 6, 6),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        )
        tip.position.set(radius, 0, 0)
        // Invisible, oversized hit-target: the visual body can be too small on screen (especially
        // at tactical-camera zoom) to reliably click — material.visible = false skips rendering
        // but three.js's raycaster still tests the geometry.
        const hitTarget = new THREE.Mesh(
          new THREE.SphereGeometry(Math.max(30, radius * 4), 6, 6),
          new THREE.MeshBasicMaterial({ visible: false }),
        )
        group = new THREE.Group()
        group.add(body, tip, hitTarget)
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
