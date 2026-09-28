import * as THREE from "three"
import { ionClient } from "../api/client"
import type { FloatingOriginPosition, ShipEntity } from "../api/types"
import { PidController } from "./pid"
import { RelayAutoTuner, type PidGains } from "./relayAutoTune"
import {
  classifyThrusters,
  readAngularVelocity,
  readFloatingPosition,
  readOrientation,
  readVelocity,
  relativeVector,
  type ModuleRef,
} from "../state/shipState"

const RAD_TO_DEG = 180 / Math.PI
const RCS_KP = 6 // pct of torque per degree of pointing error
// No integral term: pointing is a frictionless double-integrator plant (torque -> angular accel ->
// rate -> angle) with no steady-state disturbance torque to cancel out, so there's nothing for an
// integral to correct — it only eats into phase margin here. Empirically this was the actual cause
// of a *sustained* (never-settling) oscillation regardless of how P/D were tuned: a nonzero Ki on a
// plant like this is a textbook way to induce a limit cycle. Plain PD is the standard approach for
// spacecraft-style attitude pointing for exactly this reason.
const RCS_KI = 0
const RCS_KD = 8 // pct of torque per deg/s of angular rate (damps overshoot)
const RCS_INTEGRAL_LIMIT_DEG_S = 15 // clamps the integral term itself, in degree-seconds (unused while RCS_KI is 0, kept for setGains() signature)
const ALIGNMENT_TOLERANCE_DEG = 25 // only burn the main engine once pointed this close to the target heading
const APPROACH_GAIN = 0.4 // desired closing speed per meter of remaining distance, while still accelerating
const MAX_APPROACH_SPEED = 40 // m/s
const SPEED_GAIN = 20 // pct of thrust per m/s of speed error
const SPEED_DEADBAND = 0.3 // m/s — inside this, don't bother thrusting

// Neither of these is measured from the ship's actual mass/thrust (not exposed by GET) — they're
// a conservative assumed deceleration capability, used only to decide *when* to flip and start
// braking. BRAKE_MARGIN pads that estimate so the flip happens a bit early rather than late and
// overshooting.
const ASSUMED_MAX_DECEL_MPS2 = 2
const BRAKE_MARGIN = 1.3

export type AutopilotGoal = "approach" | "orbit"
export type AutopilotPhase = "idle" | "tuning" | "cruise" | "braking"

/**
 * Simplified "point and burn" autopilot: no server-side flight assist exists, so this drives the
 * same thrusters a player would (RCS to point, Fixed thruster to accelerate/decelerate) via a
 * PID pointing controller per axis (see pid.ts). On every engage(), each axis first runs a brief
 * relay-feedback self-tune (see relayAutoTune.ts) against the real thrusters before switching to
 * PID — fixed gains (even scaled by thruster count) can't account for the ship's actual mass and
 * thrust authority, and this identifies them directly from the real closed-loop response instead
 * of guessing. Two phases:
 *  - cruise: point at the target and accelerate towards it (capped at MAX_APPROACH_SPEED)
 *  - brake: once the estimated stopping distance (from current closing speed) catches up with
 *    the remaining distance, flip to point retrograde (opposite the velocity vector) and burn
 *    the same engines — now facing the "wrong" way on purpose — until closing speed reaches ~0.
 * Distances are measured to the target's surface (position + its own radius), not its center, so
 * arrival/orbit distances make sense for anything bigger than a point.
 * "orbit" is approximated by chasing a point that revolves around the target body, which
 * produces a roughly circular path but isn't a stable orbit — not real orbital mechanics.
 */
export class Autopilot {
  private thrusters = classifyThrusters(null, [])
  private getTargetPosition: ((nowMs: number) => FloatingOriginPosition | null) | null = null
  private arrivalRadius = 200
  private targetRadius = 0
  private stopMode = false
  private label = ""
  private lastTickAtMs = 0
  private yawPid = new PidController(RCS_KP, RCS_KI, RCS_KD, 100, RCS_INTEGRAL_LIMIT_DEG_S)
  private pitchPid = new PidController(RCS_KP, RCS_KI, RCS_KD, 100, RCS_INTEGRAL_LIMIT_DEG_S)
  private yawTuner = new RelayAutoTuner()
  private pitchTuner = new RelayAutoTuner()
  private yawTuned = false
  private pitchTuned = false
  private phase: AutopilotPhase = "idle"
  // The known-safe fallback Kp, kept around to sanity-clamp whatever the relay test identifies — a
  // noisy/short relay run can still yield a garbage (too small) amplitude estimate and therefore a
  // wildly inflated Ku/Kp even with the hysteresis and min-amplitude guards in relayAutoTune.ts, so
  // this is a last-resort backstop against "unstable immediately after tuning".
  private fallbackKp = RCS_KP

  setModules(modules: ModuleRef[], entity: ShipEntity | null): void {
    this.thrusters = classifyThrusters(entity, modules)

    // Rough fallback gains, scaled for the ship's actual RCS mount count (more mounts firing in
    // parallel means more torque authority per % activation) — only used until the relay
    // auto-tune below identifies real gains for this ship, and never overwrites them afterwards.
    const rcsCount = Math.max(1, this.thrusters.rcs.length)
    const scale = 1 / rcsCount
    this.fallbackKp = RCS_KP * scale
    if (this.yawTuned && this.pitchTuned) return
    if (!this.yawTuned) this.yawPid.setGains(RCS_KP * scale, RCS_KI * scale, RCS_KD * scale)
    if (!this.pitchTuned) this.pitchPid.setGains(RCS_KP * scale, RCS_KI * scale, RCS_KD * scale)
  }

  /** Caps identified gains to a sane multiple of the known-safe fallback, preserving the kd/kp ratio. */
  private clampGains(gains: PidGains): PidGains {
    const MAX_KP_MULTIPLE = 3
    const cap = this.fallbackKp * MAX_KP_MULTIPLE
    if (gains.kp <= cap) return gains
    const scale = cap / gains.kp
    return { kp: gains.kp * scale, ki: gains.ki * scale, kd: gains.kd * scale }
  }

  get engaged(): boolean {
    return this.getTargetPosition !== null || this.stopMode
  }

  get statusLabel(): string {
    return this.label
  }

  get statusPhase(): AutopilotPhase {
    return this.phase
  }

  /**
   * @param arrivalRadius how close to the target's *surface* counts as "arrived"
   * @param targetRadiusM the target body's own radius (0 for a bare point, e.g. an orbit chase point)
   */
  engage(
    getTargetPosition: (nowMs: number) => FloatingOriginPosition | null,
    arrivalRadius: number,
    targetRadiusM: number,
    label: string,
  ): void {
    this.getTargetPosition = getTargetPosition
    this.arrivalRadius = arrivalRadius
    this.targetRadius = targetRadiusM
    this.label = label
    this.lastTickAtMs = 0
    this.yawPid.reset()
    this.pitchPid.reset()
    // Re-identify gains every engage: a different target direction exercises the same thrusters
    // but a fresh relay test is cheap and avoids trusting a tune from a very different maneuver.
    this.yawTuned = false
    this.pitchTuned = false
    this.phase = "tuning"
    this.yawTuner.start(Date.now())
    this.pitchTuner.start(Date.now())
  }

  /** Null out all velocity in place — points retrograde and burns until closing speed reaches ~0, then auto-disengages. */
  engageStop(): void {
    this.getTargetPosition = null
    this.arrivalRadius = 0
    this.targetRadius = 0
    this.stopMode = true
    this.label = "Full stop"
    this.lastTickAtMs = 0
    this.yawPid.reset()
    this.pitchPid.reset()
    this.yawTuned = false
    this.pitchTuned = false
    this.phase = "tuning"
    this.yawTuner.start(Date.now())
    this.pitchTuner.start(Date.now())
  }

  disengage(): void {
    this.getTargetPosition = null
    this.stopMode = false
    this.label = ""
    this.phase = "idle"
    this.yawPid.reset()
    this.pitchPid.reset()
    for (const t of this.thrusters.rcs) {
      void ionClient.set(t.module_id, "yaw", 0)
      void ionClient.set(t.module_id, "pitch", 0)
    }
    for (const t of [...this.thrusters.fixed, ...this.thrusters.retro, ...this.thrusters.lateralQ, ...this.thrusters.lateralE]) {
      void ionClient.set(t.module_id, "activation", 0)
    }
  }

  /** Called on every ship-state poll (~15/s) — needs fresh position/orientation/velocity anyway. */
  async tick(entity: ShipEntity): Promise<void> {
    if (!this.getTargetPosition && !this.stopMode) return

    const orientation = readOrientation(entity)
    const velocity = readVelocity(entity)
    const angularVelocity = readAngularVelocity(entity)
    if (!orientation || !velocity || !angularVelocity) return

    const velocityVec = new THREE.Vector3(velocity.x, velocity.y, velocity.z)

    let braking: boolean
    let closingSpeed: number
    let remaining: number
    let pointDirection: THREE.Vector3

    if (this.stopMode) {
      const speed = velocityVec.length()
      if (speed <= SPEED_DEADBAND) {
        this.disengage()
        return
      }
      braking = true
      closingSpeed = speed
      remaining = 0
      pointDirection = velocityVec.clone().normalize().negate()
    } else {
      const shipPosition = readFloatingPosition(entity)
      if (!shipPosition) return

      const targetPosition = this.getTargetPosition!(Date.now())
      if (!targetPosition) {
        this.disengage()
        return
      }

      const [dx, dy, dz] = relativeVector(shipPosition, targetPosition)
      const distanceToCenter = Math.hypot(dx, dy, dz)
      if (distanceToCenter === 0) return

      const worldDirection = new THREE.Vector3(dx, dy, dz).normalize()
      const distanceToSurface = Math.max(0, distanceToCenter - this.targetRadius)
      remaining = distanceToSurface - this.arrivalRadius

      closingSpeed = velocityVec.dot(worldDirection) // positive = approaching the target

      const stoppingDistance = closingSpeed > 0 ? (closingSpeed * closingSpeed) / (2 * ASSUMED_MAX_DECEL_MPS2) : 0
      braking = closingSpeed > SPEED_DEADBAND && stoppingDistance * BRAKE_MARGIN >= remaining

      // Cruise: face the target and accelerate towards it. Brake: flip to face retrograde (the way
      // we're actually moving, reversed) and fire the very same engines to cancel that velocity —
      // this is the "rotate the ship, then reactivate the engines" maneuver.
      pointDirection = braking
        ? velocityVec.lengthSq() > 0
          ? velocityVec.clone().normalize().negate()
          : worldDirection.clone().negate()
        : worldDirection
    }

    const inverseOrientation = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.q).invert()
    const localDir = pointDirection.clone().applyQuaternion(inverseOrientation)

    // Yaw rotates about local Z, pitch about local Y — because X→Y→Z is the right-handed cyclic
    // order, a rotation about Z couples (x,y) with the opposite sign parity of a rotation about Y
    // coupling (z,x). Concretely: d(atan2(y,x))/dt = -yawRate, but d(asin(z))/dt = +pitchRate (not
    // -pitchRate) for the same physical sense of "rotate to reduce the error". Using a plain
    // asin(z) here without the negation made the pitch loop positive-feedback — any pitch error
    // grew instead of shrinking, saturating the RCS and spinning continuously ("a trottola") no
    // matter the gains, since no amount of tuning fixes a backwards sign.
    const yawErrorDeg = Math.atan2(localDir.y, localDir.x) * RAD_TO_DEG
    const pitchErrorDeg = -Math.asin(Math.max(-1, Math.min(1, localDir.z))) * RAD_TO_DEG
    const alignmentErrorDeg = Math.acos(Math.max(-1, Math.min(1, localDir.x))) * RAD_TO_DEG

    const yawRateDeg = angularVelocity.z * RAD_TO_DEG
    const pitchRateDeg = angularVelocity.y * RAD_TO_DEG

    const now = Date.now()
    const dtSeconds = this.lastTickAtMs === 0 ? 0 : Math.min(0.5, (now - this.lastTickAtMs) / 1000)
    this.lastTickAtMs = now

    let yawCmd: number
    if (!this.yawTuned) {
      const result = this.yawTuner.step(yawErrorDeg, now)
      yawCmd = result.command
      if (result.done) {
        this.yawTuned = true
        if (result.gains) {
          const g = this.clampGains(result.gains)
          this.yawPid.setGains(g.kp, g.ki, g.kd)
        }
      }
    } else {
      yawCmd = this.yawPid.update(yawErrorDeg, yawRateDeg, dtSeconds)
    }

    let pitchCmd: number
    if (!this.pitchTuned) {
      const result = this.pitchTuner.step(pitchErrorDeg, now)
      pitchCmd = result.command
      if (result.done) {
        this.pitchTuned = true
        if (result.gains) {
          const g = this.clampGains(result.gains)
          this.pitchPid.setGains(g.kp, g.ki, g.kd)
        }
      }
    } else {
      pitchCmd = this.pitchPid.update(pitchErrorDeg, pitchRateDeg, dtSeconds)
    }

    this.phase = !this.yawTuned || !this.pitchTuned ? "tuning" : braking ? "braking" : "cruise"

    // The relay test deliberately swings the ship off-target while it runs, so gate the main
    // engine on both axes being done tuning as well as actually aligned — otherwise a burn could
    // fire mid-swing, right as the relay happens to cross through alignment.
    let forward = 0
    if (this.yawTuned && this.pitchTuned && alignmentErrorDeg < ALIGNMENT_TOLERANCE_DEG) {
      if (braking) {
        forward = closingSpeed > SPEED_DEADBAND ? 100 : 0
      } else if (remaining > 0) {
        const desiredSpeed = Math.min(MAX_APPROACH_SPEED, remaining * APPROACH_GAIN)
        const speedError = desiredSpeed - closingSpeed
        if (speedError > SPEED_DEADBAND) forward = Math.min(100, speedError * SPEED_GAIN)
      }
    }

    const jobs: Promise<void>[] = []
    for (const t of this.thrusters.rcs) {
      jobs.push(ionClient.set(t.module_id, "yaw", yawCmd))
      jobs.push(ionClient.set(t.module_id, "pitch", pitchCmd))
      jobs.push(ionClient.set(t.module_id, "roll", 0))
    }
    for (const t of this.thrusters.fixed) jobs.push(ionClient.set(t.module_id, "activation", forward))
    for (const t of this.thrusters.retro) jobs.push(ionClient.set(t.module_id, "activation", 0))
    await Promise.all(jobs)
  }
}

export const autopilot = new Autopilot()

const ORBIT_ANGULAR_SPEED = 0.05 // rad/s — arbitrary, just needs to be slow enough to be chaseable

/** A point that revolves around `center` at `radius`, in a plane picked from the engage moment. */
export function orbitTargetPosition(
  center: FloatingOriginPosition,
  radiusM: number,
  startedAtMs: number,
): (nowMs: number) => FloatingOriginPosition {
  return (nowMs: number) => {
    const t = ((nowMs - startedAtMs) / 1000) * ORBIT_ANGULAR_SPEED
    return {
      sector: center.sector,
      shift: {
        x: center.shift.x + Math.cos(t) * radiusM,
        y: center.shift.y + Math.sin(t) * radiusM,
        z: center.shift.z,
      },
    }
  }
}
