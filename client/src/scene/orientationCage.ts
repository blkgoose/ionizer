import * as THREE from "three"

// There's no real "up" in space and often nothing nearby to look at (SystemMap scans frequently
// come back empty — see systemPanel's sparse-space note), so a rotating camera with nothing in
// frame gives zero sense of attitude. This is a deliberately fake, purely client-side reference:
// a field of fixed background stars (parallax-free, just for a sense of "am I turning") plus two
// world-axis-aligned rings (an artificial horizon + a perpendicular ring) that only translate
// with the ship, never rotate — so rolling/pitching/yawing visibly moves them, unlike the ship's
// own geometry.
const STAR_COUNT = 3000
const STAR_RADIUS_M = 4500
const RING_RADIUS_M = 3000
const RING_SEGMENTS = 128

function buildRing(color: number, plane: "xz" | "xy"): THREE.LineLoop {
  const points: THREE.Vector3[] = []
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const angle = (i / RING_SEGMENTS) * Math.PI * 2
    const a = Math.cos(angle) * RING_RADIUS_M
    const b = Math.sin(angle) * RING_RADIUS_M
    points.push(plane === "xz" ? new THREE.Vector3(a, 0, b) : new THREE.Vector3(a, b, 0))
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  return new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }))
}

export class OrientationCage {
  private group = new THREE.Group()

  constructor(scene: THREE.Scene) {
    const positions = new Float32Array(STAR_COUNT * 3)
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      positions[i * 3] = STAR_RADIUS_M * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = STAR_RADIUS_M * Math.sin(phi) * Math.sin(theta)
      positions[i * 3 + 2] = STAR_RADIUS_M * Math.cos(phi)
    }
    const starGeometry = new THREE.BufferGeometry()
    starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3))
    const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0xaaaaaa, size: 2, sizeAttenuation: false }))

    this.group.add(stars, buildRing(0x2266aa, "xz"), buildRing(0x225533, "xy"))
    scene.add(this.group)
  }

  /** Keeps the cage centered on the camera (translation only — it must never rotate). */
  syncTo(cameraPosition: THREE.Vector3): void {
    this.group.position.copy(cameraPosition)
  }
}
