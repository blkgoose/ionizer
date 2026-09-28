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
import { saveAutopilotPhase } from "../state/autopilotPhase"

const RAD_TO_DEG = 180 / Math.PI
const MAX_CALIBRATION_ATTEMPTS = 2
const TIMING_SMOOTHING = 0.2
const ALIGNMENT_TOLERANCE_DEG = 25 // safety gate during burning: cut the main engine if drift ever exceeds this mid-burn
// Cruise-speed governor for "burning": rather than a flat cap (which made a 260,000km orbit
// transit sit at a 40 m/s crawl — ~75 days — because that was tuned for meter/km-scale docking),
// desired speed follows the same sqrt(2*a*d) constant-deceleration curve the shouldBrake exit
// check already uses, so it's fast far away and naturally tapers down approaching the target,
// only ever bounded by MAX_CRUISE_SPEED. Since coasting at cruise burns no fuel (forward thrust
// only fires while accelerating/braking, see the speedError check below), 1000 m/s round-tripped
// fine fuel-wise in live testing on this ship's loadout — keep it here rather than a lower,
// more conservative estimate.
const MAX_CRUISE_SPEED = 1000 // m/s
const SPEED_GAIN = 20 // pct of thrust per m/s of speed error
const SPEED_DEADBAND = 0.3 // m/s — inside this, don't bother thrusting

// "Pointing"/"reverse" only hand off to the next phase once the ship is actually settled: aligned
// *and* no longer spinning — a loose angle-only tolerance (like the old ALIGNMENT_TOLERANCE_DEG
// gate) lets the nose swing straight through the target heading while still rotating fast, so the
// ship "looks" aligned for an instant but is still tumbling when thrust kicks in. Both conditions
// must hold continuously for POINTING_SETTLE_MS, not just on one sample, to reject noise.
const POINTING_ANGLE_TOLERANCE_DEG = 3
const POINTING_RATE_TOLERANCE_DEG_S = 1
const POINTING_SETTLE_MS = 400

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

// How long to hold the main engine at 0 before starting the turn to retrograde — gives the
// in-flight SET a tick to actually land so the ship isn't still thrusting forward while rotating.
const STOPPING_BURNER_DWELL_MS = 300

// axisCommand's delay-compensated prediction is only as good as its delay estimate: avgSetRttS is
// a slow-reacting EMA (TIMING_SMOOTHING) of round-trip latency, so a real spike (server hiccup,
// slow network) leaves the rate loop under-braking against a bigger-than-assumed delay for several
// ticks — the command stays near max for longer than the model thinks, and the ship overshoots the
// target heading before it can react. Padding the delay estimate itself (not just distance/rate
// margins) trades a little responsiveness for headroom against exactly that gap.
const RCS_DELAY_SAFETY_MARGIN = 1.5

export type AutopilotGoal = "approach" | "orbit"

/**
 * One-way state machine — each phase only ever advances forward, never reverts, so a borderline
 * measurement can't make the ship flip-flop between e.g. burning and braking every tick (unlike a
 * per-tick recomputed boolean flag, which chatters right at the decision boundary).
 *  - idle: not engaged.
 *  - tuning: RCS calibration doublet (skipped via a cached calibration if the ship's RCS loadout/
 *    size/mass haven't changed since last measured — see autopilotCalibration.ts).
 *  - pointing: aim at the target and wait for the ship to actually stop rotating (not just pass
 *    through the heading), before ever engaging the main engine.
 *  - burning: accelerate towards the target, capped at MAX_APPROACH_SPEED, until the estimated
 *    stopping distance (including the coast the upcoming flip-turn itself will cost) catches up
 *    with the remaining distance.
 *  - stoppingBurner: cut the main engine and hold it at 0 briefly before turning, so the ship
 *    doesn't rotate while still under forward thrust.
 *  - reverse: rotate to retrograde (opposite the current velocity vector) and wait for it to
 *    settle, same as pointing.
 *  - stopping: burn retrograde until closing speed reaches ~0; then either arrived (disengage) or
 *    still short of the target (loop back to pointing for another cycle).
 * "stopMode" (full stop in place) skips straight from tuning to reverse/stopping — there's no
 * target to point at or burn towards.
 * Distances are measured to the target's surface (position + its own radius), not its center, so
 * arrival/orbit distances make sense for anything bigger than a point.
 * "orbit" is approximated by chasing a point that revolves around the target body, which
 * produces a roughly circular path but isn't a stable orbit — not real orbital mechanics.
 */
export type AutopilotPhase = "idle" | "tuning" | "pointing" | "burning" | "stoppingBurner" | "reverse" | "stopping"

/**
 * The current phase is persisted (see autopilotPhase.ts) so a page refresh can resume mid-maneuver
 * via resumePhase() instead of restarting the whole approach from tuning/pointing — see main.ts's
 * pendingResume handling, which calls resumePhase() right after re-engaging the persisted goal.
 */

function isSettled(pointing: { angleDeg: number }, rates: AxisValues): boolean {
  return (
    pointing.angleDeg <= POINTING_ANGLE_TOLERANCE_DEG &&
    Math.abs(rates.yaw) <= POINTING_RATE_TOLERANCE_DEG_S &&
    Math.abs(rates.pitch) <= POINTING_RATE_TOLERANCE_DEG_S &&
    Math.abs(rates.roll) <= POINTING_RATE_TOLERANCE_DEG_S
  )
}

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
  // "Point" (context menu) engages tuning+pointing only — holds heading on the target and never
  // burns, unlike a full approach.
  private pointOnly = false
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
  // Debounce state for the pointing/reverse "settled" check (angle + rate both within tolerance
  // continuously for POINTING_SETTLE_MS).
  private settledSinceMs: number | null = null
  // When the current phase was entered — used by stoppingBurner's fixed dwell.
  private phaseEnteredAtMs = 0

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
    this.enterPhase(this.stopMode ? "reverse" : "pointing", Date.now())
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
    this.phase = "tuning"
    saveAutopilotPhase("tuning")
    this.calibrator.start(Date.now())
  }

  /** Advances the one-way state machine, resetting whatever per-phase bookkeeping the new phase needs. */
  private enterPhase(phase: AutopilotPhase, nowMs: number): void {
    this.phase = phase
    if (phase === "pointing" || phase === "reverse") this.settledSinceMs = null
    else if (phase === "stoppingBurner") this.phaseEnteredAtMs = nowMs
    saveAutopilotPhase(phase)
  }

  /**
   * Fast-forwards past tuning/pointing straight back to `storedPhase` after a refresh (see
   * autopilotPhase.ts), provided it's actually reachable for the goal that was just re-engaged
   * (e.g. a "Point"-only goal can only resume into "pointing") and a calibration is already in
   * hand — resuming into e.g. "burning" without gains would silently drift with no RCS/engine
   * correction at all, since axisCommand needs a measured gain to do anything.
   */
  resumePhase(storedPhase: AutopilotPhase | null): void {
    if (!storedPhase || !this.gains) return
    const resumable: AutopilotPhase[] = this.stopMode
      ? ["reverse", "stopping"]
      : this.pointOnly
        ? ["pointing"]
        : ["pointing", "burning", "stoppingBurner", "reverse", "stopping"]
    if (resumable.includes(storedPhase)) this.enterPhase(storedPhase, Date.now())
  }

  /** True once the ship has been continuously aligned+non-rotating for POINTING_SETTLE_MS. */
  private trackSettle(pointingNow: { angleDeg: number } | null, rates: AxisValues, nowMs: number): boolean {
    if (!pointingNow || !isSettled(pointingNow, rates)) {
      this.settledSinceMs = null
      return false
    }
    this.settledSinceMs ??= nowMs
    return nowMs - this.settledSinceMs >= POINTING_SETTLE_MS
  }

  private resetForEngage(): void {
    this.lastSampleAtMs = 0
    this.lastCommand = { yaw: 0, pitch: 0, roll: 0 }
    this.sent.clear()
    this.zeroPending = false
    this.calibrationAttempts = 0
    this.settledSinceMs = null
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
    pointOnly = false,
  ): void {
    this.getTargetPosition = getTargetPosition
    this.arrivalRadius = arrivalRadius
    this.targetRadius = targetRadiusM
    this.label = label
    this.stopMode = false
    this.pointOnly = pointOnly
    this.resetForEngage()
  }

  /** Null out all velocity in place — turns to retrograde and burns until closing speed reaches ~0, then auto-disengages. */
  engageStop(): void {
    this.getTargetPosition = null
    this.arrivalRadius = 0
    this.targetRadius = 0
    this.stopMode = true
    this.pointOnly = false
    this.label = "Full stop"
    this.resetForEngage()
  }

  disengage(): void {
    this.getTargetPosition = null
    this.stopMode = false
    this.pointOnly = false
    this.label = ""
    this.phase = "idle"
    this.gains = null
    this.settledSinceMs = null
    saveAutopilotPhase(null)
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

    if (this.stopMode && velocityVec.length() <= SPEED_DEADBAND) {
      this.disengage()
      return
    }

    const inverseOrientation = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.q).invert()

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

    // --- geometry: worldDirection/remaining/closingSpeed for approach mode, plain speed for stop mode ---
    let worldDirection: THREE.Vector3 | null = null
    let remaining = 0
    let closingSpeed: number
    if (this.stopMode) {
      closingSpeed = velocityVec.length()
    } else {
      const shipPosition = readFloatingPosition(entity)
      if (!shipPosition) return

      const targetPosition = this.getTargetPosition!(now)
      if (!targetPosition) {
        this.disengage()
        return
      }

      const [dx, dy, dz] = relativeVector(shipPosition, targetPosition)
      const distanceToCenter = Math.hypot(dx, dy, dz)
      if (distanceToCenter === 0) return

      worldDirection = new THREE.Vector3(dx, dy, dz).normalize()
      const distanceToSurface = Math.max(0, distanceToCenter - this.targetRadius)
      remaining = distanceToSurface - this.arrivalRadius
      closingSpeed = velocityVec.dot(worldDirection) // positive = approaching the target
    }

    const retrogradeDirection =
      velocityVec.lengthSq() > 0 ? velocityVec.clone().normalize().negate() : (worldDirection?.clone().negate() ?? new THREE.Vector3(1, 0, 0))

    const aimFor = (phase: AutopilotPhase): THREE.Vector3 | null => {
      switch (phase) {
        case "pointing":
        case "burning":
        case "stoppingBurner":
          return worldDirection
        case "reverse":
        case "stopping":
          return retrogradeDirection
        default:
          return null
      }
    }

    const computePointing = (dir: THREE.Vector3) => {
      const localDir = dir.clone().applyQuaternion(inverseOrientation)
      return pointingError(localDir)
    }

    if (this.phase === "tuning") this.calibrator.record(now, rates)

    // Ticks are fired without awaiting (main.ts), so skip while the previous SETs are still in
    // flight rather than letting stale commands race newer ones to the server.
    if (this.inFlight) return

    let commands: AxisValues = { yaw: 0, pitch: 0, roll: 0 }
    let forward = 0

    if (this.phase === "tuning") {
      const probe = this.calibrator.command(now)
      if (!probe.done) {
        commands = probe.values
      } else {
        const gains = this.calibrator.gains()
        if (gains.yaw !== null && gains.pitch !== null) {
          this.gains = gains
          this.persistCalibration()
          this.enterPhase(this.stopMode ? "reverse" : "pointing", now)
        } else if (this.calibrationAttempts < MAX_CALIBRATION_ATTEMPTS) {
          this.startCalibration()
        } else {
          console.warn("Autopilot: RCS calibration failed, yaw/pitch did not respond consistently", gains)
          this.disengage()
          return
        }
      }
    } else {
      // --- state-exit checks, using the CURRENT (pre-transition) phase's aim direction ---
      const currentAim = aimFor(this.phase)
      const pointingNow = currentAim ? computePointing(currentAim) : null

      switch (this.phase) {
        case "pointing":
          if (this.trackSettle(pointingNow, rates, now) && !this.pointOnly) this.enterPhase("burning", now)
          break
        case "burning": {
          const stoppingDistance = closingSpeed > 0 ? (closingSpeed * closingSpeed) / (2 * ASSUMED_MAX_DECEL_MPS2) : 0
          const turnAngleDeg = THREE.MathUtils.radToDeg(worldDirection!.angleTo(retrogradeDirection))
          const maneuverTimeS = turnAngleDeg / ASSUMED_TURN_RATE_DEG_S + MANEUVER_SETTLE_S
          const coastDuringManeuver = closingSpeed > 0 ? closingSpeed * maneuverTimeS : 0
          const shouldBrake = closingSpeed > SPEED_DEADBAND && stoppingDistance * BRAKE_MARGIN + coastDuringManeuver >= remaining
          if (shouldBrake) this.enterPhase("stoppingBurner", now)
          break
        }
        case "stoppingBurner":
          if (now - this.phaseEnteredAtMs >= STOPPING_BURNER_DWELL_MS) this.enterPhase("reverse", now)
          break
        case "reverse":
          if (this.trackSettle(pointingNow, rates, now)) this.enterPhase("stopping", now)
          break
        case "stopping":
          if (closingSpeed <= SPEED_DEADBAND) {
            if (this.stopMode || remaining <= 0) {
              this.disengage()
              return
            }
            this.enterPhase("pointing", now)
          }
          break
      }

      // --- RCS pointing + forward thrust for the (possibly just-updated) phase ---
      const gains = this.gains
      const finalAim = aimFor(this.phase)
      if (gains && finalAim) {
        const pointing = computePointing(finalAim)
        const delayS = (this.avgSetRttS + this.avgTickS) * RCS_DELAY_SAFETY_MARGIN
        const errors: AxisValues = { yaw: pointing.yawDeg, pitch: pointing.pitchDeg, roll: 0 }
        for (const axis of RCS_AXES) {
          const gain = gains[axis as RcsAxis]
          commands[axis] = gain === null ? 0 : axisCommand(errors[axis], rates[axis], gain, this.lastCommand[axis], delayS)
        }

        if (this.phase === "burning" && pointing.angleDeg < ALIGNMENT_TOLERANCE_DEG && remaining > 0) {
          const desiredSpeed = Math.min(MAX_CRUISE_SPEED, Math.sqrt(2 * ASSUMED_MAX_DECEL_MPS2 * remaining))
          const speedError = desiredSpeed - closingSpeed
          if (speedError > SPEED_DEADBAND) forward = Math.min(100, speedError * SPEED_GAIN)
        } else if (this.phase === "stopping") {
          forward = closingSpeed > SPEED_DEADBAND ? 100 : 0
        }
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
const GRAVITATIONAL_CONSTANT = 6.674e-11 // m^3 kg^-1 s^-2, matches ion server's physics.rs

// The old flat "body radius + 200m" orbit distance put the chase point basically at the surface
// for any sizeable body — survivable only by coincidence for small/low-mass bodies, and deep
// inside a gravity well far stronger than the ship's own thrust for anything planet-sized (the
// same class of bug the ion repo's fixture spawn point had to be moved away from). Gravity
// depends on the body's mass, not its diameter (galaxy.rs rolls them independently), so this
// needs mass_kg (system_map.rs) to compute an actual safe altitude instead of guessing from size
// alone. ORBIT_MAX_GRAVITY_ACCEL_MPS2 keeps gravity at the orbit distance well under
// fixed_thruster.rs's documented ~0.5 m/s^2 ship accel, leaving headroom for the ship to actually
// counter gravity *and* chase the orbit point, not just barely cancel it out.
const ORBIT_MAX_GRAVITY_ACCEL_MPS2 = 0.2

/** A safe orbit distance for a body of the given radius/mass: far enough that gravity there is comfortably within the ship's own thrust capability, never closer than the body's surface. */
export function safeOrbitRadiusM(bodyRadiusM: number, massKg: number): number {
  const gravityLimitedRadius = massKg > 0 ? Math.sqrt((GRAVITATIONAL_CONSTANT * massKg) / ORBIT_MAX_GRAVITY_ACCEL_MPS2) : 0
  return Math.max(bodyRadiusM + 200, gravityLimitedRadius)
}

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
