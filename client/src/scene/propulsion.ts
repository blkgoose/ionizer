import { ionClient } from "../api/client"
import type { ShipEntity } from "../api/types"
import { classifyThrusters, readModuleActivation, type ModuleRef } from "../state/shipState"

const ACCEL_STEP = 10

/**
 * Control scheme:
 *  - A/D: yaw (RcsThruster.yaw)              — burst: re-sent every tick while held, 0 on release
 *  - W/S: pitch (RcsThruster.pitch)           — burst
 *  - Shift+A/D: roll (RcsThruster.roll)       — burst; A/D's meaning flips to roll while Shift is held
 *  - Q/E: lateral movement (SteeringThruster mounts pointing ~90/~270, .activation only) — burst
 *  - Shift+W/S: forward/reverse acceleration +/- — the one exception: a single SET per press (not
 *    held-repeat). Positive drives the FixedThruster (forward); negative drives the SteeringThruster
 *    mount pointing ~180 (retro) instead, since a FixedThruster can't push backward.
 */
export class IntelligentPropulsion {
  private keyDown = { a: false, d: false, w: false, s: false, q: false, e: false, shift: false }

  private rcsThrusters: ModuleRef[] = []
  private fixedThrusters: ModuleRef[] = []
  private retroThrusters: ModuleRef[] = []
  private lateralQThrusters: ModuleRef[] = []
  private lateralEThrusters: ModuleRef[] = []

  private lastSent = { yaw: 0, pitch: 0, roll: 0, steeringQ: 0, steeringE: 0 }
  private accel = 0 // signed: >0 drives fixed thrusters forward, <0 drives retro thrusters

  // Manual keyboard control yields the thrusters to the autopilot while this is false — see
  // autopilot.ts, which flips it off on engage and back on on disengage/abort.
  enabled = true

  constructor() {
    window.addEventListener("keydown", (e) => this.onKey(e, true))
    window.addEventListener("keyup", (e) => this.onKey(e, false))
  }

  setModules(modules: ModuleRef[], entity: ShipEntity | null): void {
    const groups = classifyThrusters(entity, modules)
    this.rcsThrusters = groups.rcs
    this.fixedThrusters = groups.fixed
    this.retroThrusters = groups.retro
    this.lateralQThrusters = groups.lateralQ
    this.lateralEThrusters = groups.lateralE
  }

  /** Keeps the acceleration baseline honest against the server's own values between our own bumps. */
  syncFromEntity(entity: ShipEntity): void {
    const forward = this.fixedThrusters[0] ? readModuleActivation(entity, this.fixedThrusters[0].module_id) : null
    const retro = this.retroThrusters[0] ? readModuleActivation(entity, this.retroThrusters[0].module_id) : null

    if (forward !== null && forward > 0) this.accel = forward
    else if (retro !== null && retro > 0) this.accel = -retro
    else this.accel = 0
  }

  private onKey(event: KeyboardEvent, pressed: boolean): void {
    if (!this.enabled) return
    const key = event.key.toLowerCase()

    if (key === "shift") {
      this.keyDown.shift = pressed
      return
    }

    if ((key === "w" || key === "s") && event.shiftKey) {
      if (pressed && !event.repeat) {
        this.bumpAcceleration(key === "w" ? 1 : -1)
      }
      return
    }

    if (key in this.keyDown) {
      ;(this.keyDown as Record<string, boolean>)[key] = pressed
    }
  }

  private bumpAcceleration(direction: 1 | -1): void {
    this.accel = Math.min(100, Math.max(-100, this.accel + direction * ACCEL_STEP))

    const forwardValue = this.accel > 0 ? this.accel : 0
    const retroValue = this.accel < 0 ? -this.accel : 0

    for (const t of this.fixedThrusters) void ionClient.set(t.module_id, "activation", forwardValue)
    for (const t of this.retroThrusters) void ionClient.set(t.module_id, "activation", retroValue)
  }

  /** Called on a fixed tick; only issues SET when a burst axis's value actually changed. */
  async tick(): Promise<void> {
    if (!this.enabled) return
    const shiftHeld = this.keyDown.shift

    // A/D and W/S are swapped from what you'd naively expect (A/D drive pitch, W/S drive yaw) —
    // per the operator's own correction, not a mistake.
    const yaw = shiftHeld ? 0 : (this.keyDown.w ? 100 : 0) - (this.keyDown.s ? 100 : 0)
    const pitch = shiftHeld ? 0 : (this.keyDown.a ? 100 : 0) - (this.keyDown.d ? 100 : 0)
    const roll = shiftHeld ? (this.keyDown.d ? 100 : 0) - (this.keyDown.a ? 100 : 0) : 0
    const steeringQ = this.keyDown.q ? 100 : 0
    const steeringE = this.keyDown.e ? 100 : 0

    const jobs: Promise<void>[] = []

    if (yaw !== this.lastSent.yaw || pitch !== this.lastSent.pitch || roll !== this.lastSent.roll) {
      this.lastSent.yaw = yaw
      this.lastSent.pitch = pitch
      this.lastSent.roll = roll
      for (const t of this.rcsThrusters) {
        jobs.push(ionClient.set(t.module_id, "yaw", yaw))
        jobs.push(ionClient.set(t.module_id, "pitch", pitch))
        jobs.push(ionClient.set(t.module_id, "roll", roll))
      }
    }

    if (steeringQ !== this.lastSent.steeringQ) {
      this.lastSent.steeringQ = steeringQ
      for (const t of this.lateralQThrusters) jobs.push(ionClient.set(t.module_id, "activation", steeringQ))
    }
    if (steeringE !== this.lastSent.steeringE) {
      this.lastSent.steeringE = steeringE
      for (const t of this.lateralEThrusters) jobs.push(ionClient.set(t.module_id, "activation", steeringE))
    }

    await Promise.all(jobs)
  }
}
