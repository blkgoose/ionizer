import * as THREE from "three"
import type { FloatingOriginPosition, SystemMapEntry } from "../api/types"
import { relativeVector } from "../state/shipState"

// Real distances are light-years; nothing renders sensibly at true scale. Stars/planets are
// placed at a fixed distance along their real direction from the camera instead — a skybox,
// not a to-scale model. Rebuilt wholesale on every call: SystemMap entries have no stable id
// to diff against, and there are only ever a handful within the 1 ly scan radius.
const SKY_RADIUS_M = 5000

export class Starfield {
  private group = new THREE.Group()
  private light = new THREE.DirectionalLight(0xfff4e6, 0)
  private lightTarget = new THREE.Object3D()

  constructor(scene: THREE.Scene) {
    scene.add(this.group)
    scene.add(this.lightTarget)
    this.light.target = this.lightTarget
    scene.add(this.light)
  }

  update(cameraPosition: THREE.Vector3, shipPosition: FloatingOriginPosition, entries: SystemMapEntry[]): void {
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0])
    }

    let nearestStarDir: THREE.Vector3 | null = null
    let nearestStarDistance = Infinity

    for (const entry of entries) {
      const [dx, dy, dz] = relativeVector(shipPosition, entry.position)
      const distance = Math.hypot(dx, dy, dz)
      if (distance === 0) continue
      const direction = new THREE.Vector3(dx, dy, dz).normalize()

      const isStar = entry.kind === "star"
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(isStar ? 60 : 20, 6, 6),
        isStar
          ? new THREE.MeshBasicMaterial({ color: 0xfff4c2 })
          : new THREE.MeshLambertMaterial({ color: 0x6699cc, flatShading: true }),
      )
      mesh.position
        .copy(cameraPosition)
        .addScaledVector(direction, SKY_RADIUS_M * (isStar ? 1 : 0.85))
      this.group.add(mesh)

      if (isStar && distance < nearestStarDistance) {
        nearestStarDistance = distance
        nearestStarDir = direction
      }
    }

    if (nearestStarDir) {
      this.light.position.copy(cameraPosition).addScaledVector(nearestStarDir, 100)
      this.lightTarget.position.copy(cameraPosition)
      this.light.intensity = 1.4
    } else {
      this.light.intensity = 0
    }
  }
}
