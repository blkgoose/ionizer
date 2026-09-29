import * as THREE from "three"
import { isInputCaptured } from "../state/inputCapture"

const ZOOM_FACTOR = 1.15
const MIN_DISTANCE = 20
const MAX_DISTANCE = 20000
const ROTATE_SPEED = 0.005
const PAN_SPEED_AT_UNIT_DISTANCE = 0.08 // m/s of pan per meter of current zoom distance

// Speed-based auto-dolly: hugs the ship close while it's stopped, backs off as it picks up speed
// so a fast-moving ship (and the ground rushing past it) doesn't fill the whole frame.
const AUTO_DISTANCE_BASE_M = 500
const AUTO_DISTANCE_PER_MPS = 15
const AUTO_DISTANCE_MAX_M = 6000
const AUTO_DISTANCE_LERP = 2 // 1/s — smoothing rate, not an instant snap to the target distance

// Auto-orient rotates yaw to a 3/4 view of the ship relative to whatever it's currently aimed at
// (the live autopilot target), so both the ship and the point it's headed towards stay framed
// without the player ever having to drag the view themselves.
const AUTO_ORIENT_OFFSET_RAD = (Math.PI * 3) / 4 // 135°: behind-and-to-the-side, not dead-on-axis
const AUTO_ORIENT_LERP = 3 // 1/s

/**
 * CAD-style orbit camera for tactical mode: the camera orbits `center` at `distance` along
 * (yaw, pitch) — zoom is mouse wheel, orbit is right-mouse-drag, WASD/arrows pan `center` on the
 * world X/Y plane (the same plane radar contacts and system-map entries are already placed in —
 * see scene.ts, which maps shift.x/y/z straight onto three.js x/y/z with no remapping).
 * `center` auto-follows the ship's live position every tick — until a WASD/arrow pan moves it on
 * purpose, at which point it stops following and stays wherever panned; Space snaps it back onto
 * the ship and resumes auto-follow.
 */
export class TacticalCameraController {
  readonly center = new THREE.Vector3()
  private shipPosition = new THREE.Vector3()
  private shipSpeed = 0
  private aimPoint: THREE.Vector3 | null = null
  private following = true
  private autoDistance = true
  private autoOrient = true
  private distance = 2000
  private yaw = 0
  private pitch = 0.6
  private keyDown = { up: false, down: false, left: false, right: false }
  private dragging = false
  private lastX = 0
  private lastY = 0

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.autoDistance = false
    this.distance *= e.deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
    this.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, this.distance))
  }

  private readonly onContextMenu = (e: MouseEvent): void => e.preventDefault()

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 2) return
    this.dragging = true
    this.lastX = e.clientX
    this.lastY = e.clientY
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.autoOrient = false
    this.yaw -= dx * ROTATE_SPEED
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * ROTATE_SPEED))
  }

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.dragging = false
  }

  private readonly onKey = (e: KeyboardEvent, pressed: boolean): void => {
    // A modal (e.g. the Ctrl+K point picker) is using these same keys for its own navigation right
    // now — don't also pan the camera underneath it. Only guards the press, not the release, so a
    // key already held before the modal opened still clears correctly on keyup.
    if (pressed && isInputCaptured()) return
    const key = e.key.toLowerCase()
    if (key === "w" || key === "arrowup") this.keyDown.up = pressed
    else if (key === "s" || key === "arrowdown") this.keyDown.down = pressed
    else if (key === "a" || key === "arrowleft") this.keyDown.left = pressed
    else if (key === "d" || key === "arrowright") this.keyDown.right = pressed
    else if (key === " " && pressed) this.recenter()

    // Any actual pan press breaks auto-follow so the pan goes somewhere instead of being
    // overwritten by the next setShipPosition() call.
    if (pressed && (key === "w" || key === "s" || key === "a" || key === "d" || key.startsWith("arrow"))) {
      this.following = false
    }
  }

  private readonly onKeyDown = (e: KeyboardEvent) => this.onKey(e, true)
  private readonly onKeyUp = (e: KeyboardEvent) => this.onKey(e, false)

  private readonly camera: THREE.PerspectiveCamera
  private readonly domElement: HTMLElement

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera
    this.domElement = domElement
    domElement.addEventListener("wheel", this.onWheel, { passive: false })
    domElement.addEventListener("contextmenu", this.onContextMenu)
    domElement.addEventListener("mousedown", this.onMouseDown)
    window.addEventListener("mousemove", this.onMouseMove)
    window.addEventListener("mouseup", this.onMouseUp)
    window.addEventListener("keydown", this.onKeyDown)
    window.addEventListener("keyup", this.onKeyUp)
  }

  /** Called every ship-state poll. Moves `center` along with the ship, unless auto-follow was broken by a manual pan. */
  setShipPosition(position: [number, number, number]): void {
    this.shipPosition.set(...position)
    if (this.following) this.center.copy(this.shipPosition)
  }

  /** Called every ship-state poll with the ship's current speed (m/s), driving the auto-dolly (see AUTO_DISTANCE_*). */
  setShipSpeed(speedMps: number): void {
    this.shipSpeed = speedMps
  }

  /** Called every ship-state poll with the live autopilot target (world space), or null when idle — drives auto-orient. */
  setAimPoint(point: THREE.Vector3 | null): void {
    this.aimPoint = point
  }

  /** Snaps the orbit center back onto the ship and resumes auto-follow/auto-dolly/auto-orient (Space). */
  recenter(): void {
    this.center.copy(this.shipPosition)
    this.following = true
    this.autoDistance = true
    this.autoOrient = true
  }

  /** Called every render frame; dtSeconds drives the WASD/arrow pan speed and the auto-dolly/auto-orient smoothing. */
  update(dtSeconds: number): void {
    const panAmount = PAN_SPEED_AT_UNIT_DISTANCE * this.distance * dtSeconds
    if (this.keyDown.up) this.center.y += panAmount
    if (this.keyDown.down) this.center.y -= panAmount
    if (this.keyDown.left) this.center.x -= panAmount
    if (this.keyDown.right) this.center.x += panAmount

    if (this.autoDistance) {
      const desiredDistance = Math.min(AUTO_DISTANCE_MAX_M, AUTO_DISTANCE_BASE_M + this.shipSpeed * AUTO_DISTANCE_PER_MPS)
      this.distance += (desiredDistance - this.distance) * Math.min(1, AUTO_DISTANCE_LERP * dtSeconds)
    }

    if (this.autoOrient && this.aimPoint) {
      const dx = this.aimPoint.x - this.center.x
      const dz = this.aimPoint.z - this.center.z
      if (dx * dx + dz * dz > 1e-6) {
        const targetYaw = Math.atan2(dx, dz)
        const desiredYaw = targetYaw + AUTO_ORIENT_OFFSET_RAD
        // Shortest-path angle diff so the yaw doesn't unwind the long way around at the ±π wrap.
        const diff = Math.atan2(Math.sin(desiredYaw - this.yaw), Math.cos(desiredYaw - this.yaw))
        this.yaw += diff * Math.min(1, AUTO_ORIENT_LERP * dtSeconds)
      }
    }

    const offset = new THREE.Vector3(
      Math.cos(this.pitch) * Math.sin(this.yaw),
      Math.sin(this.pitch),
      Math.cos(this.pitch) * Math.cos(this.yaw),
    ).multiplyScalar(this.distance)

    this.camera.position.copy(this.center).add(offset)
    this.camera.lookAt(this.center)
  }

  dispose(): void {
    this.domElement.removeEventListener("wheel", this.onWheel)
    this.domElement.removeEventListener("contextmenu", this.onContextMenu)
    this.domElement.removeEventListener("mousedown", this.onMouseDown)
    window.removeEventListener("mousemove", this.onMouseMove)
    window.removeEventListener("mouseup", this.onMouseUp)
    window.removeEventListener("keydown", this.onKeyDown)
    window.removeEventListener("keyup", this.onKeyUp)
  }
}
