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

    window.addEventListener("resize", () => this.onResize())
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
        group = new THREE.Group()
        group.add(body, tip)
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

  render(): void {
    this.orientationCage.syncTo(this.camera.position)
    this.renderer.render(this.scene, this.camera)
  }
}
