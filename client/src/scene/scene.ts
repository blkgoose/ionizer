import * as THREE from "three"
import type { OrientationQuaternion } from "../state/shipState"

// Ship-local "forward" is +X (see FixedThruster: force applied along local (1,0,0), then rotated
// by body orientation) but three.js's camera looks down its local -Z by default. This fixed
// rotation (-90 deg about Y) reconciles the two spaces before the ship's real orientation quaternion
// is applied, so the cockpit view actually turns to match the ship's real attitude instead of
// only ever looking along world -Z.
const CAMERA_TO_SHIP_SPACE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2)

export interface RadarContact {
  entityId: string
  position: [number, number, number]
  mineable?: boolean
}

export class FlightScene {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private contacts = new Map<string, THREE.Object3D>()

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000)

    // Low fill light only — the real "sun" now comes from Starfield, driven by whatever
    // star the SystemMap scan actually finds nearby, so lighting reflects where we are.
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15))

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
      let mesh = this.contacts.get(contact.entityId)
      if (!mesh) {
        const geometry = contact.mineable
          ? new THREE.IcosahedronGeometry(50, 0)
          : new THREE.BoxGeometry(40, 20, 60)
        const material = new THREE.MeshLambertMaterial({
          color: contact.mineable ? 0x555555 : 0xcc3333,
          flatShading: true,
        })
        mesh = new THREE.Mesh(geometry, material)
        this.scene.add(mesh)
        this.contacts.set(contact.entityId, mesh)
      }
      mesh.position.set(...contact.position)
    }

    for (const [id, mesh] of this.contacts) {
      if (!seen.has(id)) {
        this.scene.remove(mesh)
        this.contacts.delete(id)
      }
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }
}
