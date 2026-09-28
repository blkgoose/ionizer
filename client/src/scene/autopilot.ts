import * as THREE from "three"
import { ionClient } from "../api/client"
import type { FloatingOriginPosition, ShipEntity } from "../api/types"
import { axisCommand, pointingError, RCS_AXES, RcsCalibrator, type AxisGains, type AxisValues, type RcsAxis } from "./attitude"
import {
  classifyThrusters,
  readAngularVelocity,
  readFloatingPosition,
  readOrientation,
  readShipMass,
  readShipSize,
  readVelocity,
  relativeVector,
  type ModuleRef,
} from "../state/shipState"
import { calibrationMatches, loadAutopilotCalibration, saveAutopilotCalibration } from "../state/autopilotCalibration"

const RAD_TO_DEG = 180 / Math.PI
const MAX_CALIBRATION_ATTEMPTS = 2
const TIMING_SMOOTHING = 0.2
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

// The brake flip isn't instant: the ship has to rotate ~180° to retrograde and let the rate loop
// settle before the burn is actually effective, and it keeps coasting at closingSpeed the whole
// time. ASSUMED_TURN_RATE_DEG_S is a conservative average turn rate (well under attitude.ts's
// MAX_RATE_DEG_S, to account for ramp-up/down) used only to estimate how much distance that
// coasting eats up — not to control the turn itself. MANEUVER_SETTLE_S pads that further for the
// rate loop to kill residual spin once pointed.
const ASSUMED_TURN_RATE_DEG_S = 20
const MANEUVER_SETTLE_S = 1.5

// axisCommand's delay-compensated prediction is only as good as its delay estimate: avgSetRttS is
// a slow-reacting EMA (TIMING_SMOOTHING) of round-trip latency, so a real spike (server hiccup,
// slow network) leaves the rate loop under-braking against a bigger-than-assumed delay for several
// ticks — the command stays near max for longer than the model thinks, and the ship overshoots the
// target heading before it can react. Padding the delay estimate itself (not just distance/rate
// margins) trades a little responsiveness for headroom against exactly that gap.
const RCS_DELAY_SAFETY_MARGIN = 1.5

export type AutopilotGoal = "approach" | "orbit"
export type AutopilotPhase = "idle" | "calibrating" | "cruise" | "braking"

/**
 * Simplified "point and burn" autopilot: no server-side flight assist exists, so this drives the
 * same thrusters a player would (RCS to point, Fixed thruster to accelerate/decelerate). Pointing
 * uses a braking-curve controller per RCS axis (see attitude.ts); on every engage() a short RCS
 * doublet first measures the ship's actual angular acceleration per % of command, since that
 * depends on ship size and can't be a constant. Two phases:
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
  private calibrator = new RcsCalibrator()
  private calibrationAttempts = 0
  private gains: AxisGains | null = null
  private phase: AutopilotPhase = "idle"
  private rcsIds = ""
  private sizeM: number | null = null
  private massKg: number | null = null
  private cachedCalibration = loadAutopilotCalibration()
  private lastSampleAtMs = 0
  private avgTickS = 0.066
  private avgSetRttS = 0.05
  private inFlight = false
  private zeroPending = false
  private lastCommand: AxisValues = { yaw: 0, pitch: 0, roll: 0 }
  // Last value actually sent per module+variable, so unchanged values aren't re-sent every tick.
  private sent = new Map<string, number>()

  setModules(modules: ModuleRef[], entity: ShipEntity | null): void {
    this.thrusters = classifyThrusters(entity, modules)
    this.sizeM = entity ? readShipSize(entity) : null
    this.massKg = entity ? readShipMass(entity) : null
    const rcsIds = this.thrusters.rcs.map((t) => t.module_id).join(",")
    if (rcsIds !== this.rcsIds) {
      this.rcsIds = rcsIds
      if (this.engaged && !this.tryUseCachedCalibration()) this.startCalibration()
    }
  }

  /** Reuses a previously-measured calibration instead of re-running the doublet, if one matches the ship's current RCS loadout/size/mass (see autopilotCalibration.ts). */
  private tryUseCachedCalibration(): boolean {
    if (this.sizeM === null || this.massKg === null) return false
    const cached = this.cachedCalibration
    if (!cached || !calibrationMatches(cached, this.rcsIds, this.sizeM, this.massKg)) return false
    this.gains = cached.gains
    this.phase = "cruise"
    return true
  }

  private persistCalibration(): void {
    if (!this.gains || this.sizeM === null || this.massKg === null) return
    this.cachedCalibration = { rcsIds: this.rcsIds, sizeM: this.sizeM, massKg: this.massKg, gains: this.gains }
    saveAutopilotCalibration(this.cachedCalibration)
  }

  private startCalibration(): void {
    this.gains = null
    this.calibrationAttempts++
    this.phase = "calibrating"
    this.calibrator.start(Date.now())
  }

  private resetForEngage(): void {
    this.lastSampleAtMs = 0
    this.lastCommand = { yaw: 0, pitch: 0, roll: 0 }
    this.sent.clear()
    this.zeroPending = false
    this.calibrationAttempts = 0
    if (!this.tryUseCachedCalibration()) this.startCalibration()
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
    this.stopMode = false
    this.resetForEngage()
  }

  /** Null out all velocity in place — points retrograde and burns until closing speed reaches ~0, then auto-disengages. */
  engageStop(): void {
    this.getTargetPosition = null
    this.arrivalRadius = 0
    this.targetRadius = 0
    this.stopMode = true
    this.label = "Full stop"
    this.resetForEngage()
  }

  disengage(): void {
    this.getTargetPosition = null
    this.stopMode = false
    this.label = ""
    this.phase = "idle"
    this.gains = null
    // A tick's SETs may still be in flight; zeroing now could land before them and leave thrusters
    // firing, so defer until that tick completes.
    if (this.inFlight) this.zeroPending = true
    else this.sendZeros()
  }

  private sendZeros(): void {
    this.zeroPending = false
    this.sent.clear()
    this.lastCommand = { yaw: 0, pitch: 0, roll: 0 }
    for (const t of this.thrusters.rcs) {
      for (const axis of RCS_AXES) void ionClient.set(t.module_id, axis, 0)
    }
    for (const t of [...this.thrusters.fixed, ...this.thrusters.retro, ...this.thrusters.lateralQ, ...this.thrusters.lateralE]) {
      void ionClient.set(t.module_id, "activation", 0)
    }
  }

  private queueSet(jobs: Promise<void>[], moduleId: string, variable: string, value: number): void {
    const rounded = Math.round(value * 10) / 10
    const key = `${moduleId}:${variable}`
    if (this.sent.get(key) === rounded) return
    this.sent.set(key, rounded)
    jobs.push(ionClient.set(moduleId, variable, rounded))
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

      // How far the flip-to-retrograde maneuver itself would coast before the burn can start:
      // the turn angle is close to 180° whenever the ship's been tracking the target well (cruise
      // points at the target, braking points opposite the velocity vector), but computing the
      // actual angle between them handles cases with real lateral drift too.
      const retrogradeDirection = velocityVec.lengthSq() > 0 ? velocityVec.clone().normalize().negate() : worldDirection.clone().negate()
      const turnAngleDeg = THREE.MathUtils.radToDeg(worldDirection.angleTo(retrogradeDirection))
      const maneuverTimeS = turnAngleDeg / ASSUMED_TURN_RATE_DEG_S + MANEUVER_SETTLE_S
      const coastDuringManeuver = closingSpeed > 0 ? closingSpeed * maneuverTimeS : 0

      braking = closingSpeed > SPEED_DEADBAND && stoppingDistance * BRAKE_MARGIN + coastDuringManeuver >= remaining

      // Cruise: face the target and accelerate towards it. Brake: flip to face retrograde (the way
      // we're actually moving, reversed) and fire the very same engines to cancel that velocity —
      // this is the "rotate the ship, then reactivate the engines" maneuver.
      pointDirection = braking ? retrogradeDirection : worldDirection
    }

    const inverseOrientation = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.q).invert()
    const localDir = pointDirection.clone().applyQuaternion(inverseOrientation)
    const pointing = pointingError(localDir)

    // Body-frame rates, right-handed: +Z (yaw) swings the nose towards +Y and +Y (pitch) towards −Z,
    // so a positive rate reduces a positive pointingError() component on both axes.
    const rates: AxisValues = {
      yaw: angularVelocity.z * RAD_TO_DEG,
      pitch: angularVelocity.y * RAD_TO_DEG,
      roll: angularVelocity.x * RAD_TO_DEG,
    }

    const now = Date.now()
    if (this.lastSampleAtMs !== 0) {
      const dt = Math.min(0.5, (now - this.lastSampleAtMs) / 1000)
      this.avgTickS += TIMING_SMOOTHING * (dt - this.avgTickS)
    }
    this.lastSampleAtMs = now
    if (this.phase === "calibrating") this.calibrator.record(now, rates)

    // Ticks are fired without awaiting (main.ts), so skip while the previous SETs are still in
    // flight rather than letting stale commands race newer ones to the server.
    if (this.inFlight) return

    let commands: AxisValues = { yaw: 0, pitch: 0, roll: 0 }
    if (this.phase === "calibrating") {
      const probe = this.calibrator.command(now)
      if (!probe.done) {
        commands = probe.values
      } else {
        const gains = this.calibrator.gains()
        if (gains.yaw !== null && gains.pitch !== null) {
          this.gains = gains
          this.persistCalibration()
        } else if (this.calibrationAttempts < MAX_CALIBRATION_ATTEMPTS) {
          this.startCalibration()
        } else {
          console.warn("Autopilot: RCS calibration failed, yaw/pitch did not respond consistently", gains)
          this.disengage()
          return
        }
      }
    }

    const gains = this.gains
    if (gains) {
      const delayS = (this.avgSetRttS + this.avgTickS) * RCS_DELAY_SAFETY_MARGIN
      const errors: AxisValues = { yaw: pointing.yawDeg, pitch: pointing.pitchDeg, roll: 0 }
      for (const axis of RCS_AXES) {
        const gain = gains[axis as RcsAxis]
        commands[axis] = gain === null ? 0 : axisCommand(errors[axis], rates[axis], gain, this.lastCommand[axis], delayS)
      }
      this.phase = braking ? "braking" : "cruise"
    }

    let forward = 0
    if (gains && pointing.angleDeg < ALIGNMENT_TOLERANCE_DEG) {
      if (braking) {
        forward = closingSpeed > SPEED_DEADBAND ? 100 : 0
      } else if (remaining > 0) {
        const desiredSpeed = Math.min(MAX_APPROACH_SPEED, remaining * APPROACH_GAIN)
        const speedError = desiredSpeed - closingSpeed
        if (speedError > SPEED_DEADBAND) forward = Math.min(100, speedError * SPEED_GAIN)
      }
    }

    this.lastCommand = commands
    const jobs: Promise<void>[] = []
    for (const t of this.thrusters.rcs) {
      for (const axis of RCS_AXES) this.queueSet(jobs, t.module_id, axis, commands[axis])
    }
    for (const t of this.thrusters.fixed) this.queueSet(jobs, t.module_id, "activation", forward)
    for (const t of this.thrusters.retro) this.queueSet(jobs, t.module_id, "activation", 0)
    if (jobs.length === 0) return

    this.inFlight = true
    const sentAt = performance.now()
    try {
      await Promise.all(jobs)
      this.avgSetRttS += TIMING_SMOOTHING * (Math.min(1, (performance.now() - sentAt) / 1000) - this.avgSetRttS)
    } catch (error) {
      this.sent.clear()
      console.warn("Autopilot: SET failed, resending everything next tick", error)
    } finally {
      this.inFlight = false
      if (this.zeroPending) this.sendZeros()
    }
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
