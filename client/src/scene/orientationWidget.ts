import * as THREE from "three"
import type { OrientationQuaternion } from "../state/shipState"

const SIZE_PX = 120

export class OrientationWidget {
  readonly domElement: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private shipMock: THREE.Mesh

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(SIZE_PX, SIZE_PX)
    this.domElement = this.renderer.domElement

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this.camera.position.set(2, 1.5, 2.5)
    this.camera.lookAt(0, 0, 0)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const fill = new THREE.DirectionalLight(0xffffff, 0.6)
    fill.position.set(2, 3, 2)
    this.scene.add(fill)

    // World reference axes (X red, Y green, Z blue) rooted at 0,0,0 — the "rispetto agli assi
    // x/y/z 0" the operator asked for; the ship mock's orientation is drawn against these.
    this.scene.add(new THREE.AxesHelper(1.4))

    // Baked into the geometry (not a mesh rotation) so the mesh's own quaternion stays free to
    // represent the ship's real orientation untouched.
    const geometry = new THREE.ConeGeometry(0.25, 1, 6)
    geometry.rotateX(Math.PI / 2)
    this.shipMock = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color: 0xcc3333, flatShading: true }))
    this.scene.add(this.shipMock)
  }

  update(orientation: OrientationQuaternion | null): void {
    if (orientation) {
      this.shipMock.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.q)
    }
    this.renderer.render(this.scene, this.camera)
  }
}
