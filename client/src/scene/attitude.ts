/**
 * Attitude control for a frictionless rigid body: an RCS command sets torque, so each axis is a pure
 * double integrator (command -> angular accel -> rate -> angle) with a hard ±100% actuator limit and
 * no drag to bleed off rotation. A linear PD can't handle that once the RCS saturates: it starts
 * braking at an error proportional to the rate, while the distance actually needed to stop grows
 * with rate², so any large slew overshoots. Instead each axis follows a square-root braking curve
 * (the rate from which the measured deceleration stops exactly at the target) and a fast rate loop
 * tracks it.
 */

export const RCS_AXES = ["yaw", "pitch", "roll"] as const
export type RcsAxis = (typeof RCS_AXES)[number]
export type AxisValues = Record<RcsAxis, number>
/** Signed angular acceleration produced per % of RCS command, deg/s² per % — null if the axis didn't respond. */
export type AxisGains = Record<RcsAxis, number | null>

const MAX_COMMAND = 100
// Fraction of the measured max angular accel the braking curve plans with; the rest is headroom
// for the rate loop to catch up with estimation error and latency.
const BRAKING_ACCEL_FRACTION = 0.6
const MAX_RATE_DEG_S = 45
const MIN_RATE_LOOP_TIME_S = 0.15
const COMMAND_DEADBAND = 0.1
// How long a pointing slew should take to settle, independent of link latency. Previously the
// slew's own target-rate gain (p below) was derived straight from the fast inner rate loop's
// timing, so any sizeable error commanded close to MAX_RATE_DEG_S immediately ("full blast") —
// fine for tracking a commanded rate precisely, but not for the outer decision of how hard to
// turn towards the target in the first place, which is what was causing overshoot-prone,
// too-aggressive slews. Settling is ~3 time constants for an exponential (linear-gain) approach.
const POINTING_SETTLE_TIME_S = 12
const POINTING_SLEW_P = 3 / POINTING_SETTLE_TIME_S

/**
 * Desired rate towards the target: linear (gain p) close in, then √(2·a·|err|) once that would need
 * more than `accel` to stop — continuous in value and slope at the handover.
 */
export function brakingCurveRate(errDeg: number, accelDegS2: number, p: number): number {
  const linearLimit = accelDegS2 / (p * p)
  const absErr = Math.abs(errDeg)
  const rate = absErr <= linearLimit ? p * absErr : Math.sqrt(2 * accelDegS2 * (absErr - linearLimit / 2))
  return Math.sign(errDeg) * Math.min(MAX_RATE_DEG_S, rate)
}

/**
 * One RCS axis command.
 * @param errDeg angle still to rotate; positive rate reduces positive error
 * @param rateDegS measured angular rate on this axis
 * @param gain signed deg/s² per % (from calibration)
 * @param lastCommand command currently in effect (still acting during `delayS`)
 * @param delayS estimated sample-to-actuation delay; the state is predicted this far ahead
 */
export function axisCommand(errDeg: number, rateDegS: number, gain: number, lastCommand: number, delayS: number): number {
  const maxAccel = Math.abs(gain) * MAX_COMMAND
  const predictedRate = rateDegS + gain * lastCommand * delayS
  const predictedErr = errDeg - ((rateDegS + predictedRate) / 2) * delayS

  const rateLoopTimeS = Math.max(MIN_RATE_LOOP_TIME_S, 2 * delayS)
  const desiredRate = brakingCurveRate(predictedErr, BRAKING_ACCEL_FRACTION * maxAccel, POINTING_SLEW_P)

  const desiredAccel = (desiredRate - predictedRate) / rateLoopTimeS
  const command = Math.max(-MAX_COMMAND, Math.min(MAX_COMMAND, desiredAccel / gain))
  return Math.abs(command) < COMMAND_DEADBAND ? 0 : command
}

/**
 * Rotation vector (deg) about body pitch (Y) and yaw (Z) that turns body forward (+X) onto `localDir`
 * along the shortest arc. Unlike separate atan2/asin angles this has no ±180° wrap and doesn't
 * saturate at ±90°, so the error never flips sign mid-slew.
 */
export function pointingError(localDir: { x: number; y: number; z: number }): { yawDeg: number; pitchDeg: number; angleDeg: number } {
  const lateral = Math.hypot(localDir.y, localDir.z)
  const angleDeg = Math.atan2(lateral, localDir.x) * (180 / Math.PI)
  if (lateral < 1e-9) return { yawDeg: localDir.x < 0 ? angleDeg : 0, pitchDeg: 0, angleDeg }
  return { yawDeg: (angleDeg * localDir.y) / lateral, pitchDeg: (-angleDeg * localDir.z) / lateral, angleDeg }
}

const MIN_PROBE_SEGMENT_MS = 600
// Heavy ships / weak RCS loadouts can take a while to move the rate by PROBE_RATE_CHANGE_DEG_S —
// this used to cap at 2000ms, which was routinely too short for anything but a light, well-RCS'd
// ship: the segment ended before it ever cleared the noise floor, so gain() saw a near-flat slope,
// fell under MIN_ACCEL_DEG_S2, and calibration failed (silently disengaging the autopilot — see
// MAX_CALIBRATION_ATTEMPTS in autopilot.ts). Longer headroom costs a slower calibration, not a
// worse one.
const MAX_PROBE_SEGMENT_MS = 6000
// An axis's + segment keeps going until its rate has moved this much (weak ships need longer to rise
// above measurement noise); its − segment then mirrors that duration so the rate ends where it began.
// Lower than before so a genuinely weak-but-real response still clears the bar well inside the
// (now longer) MAX_PROBE_SEGMENT_MS window, instead of needing a big rate swing to end the segment early.
const PROBE_RATE_CHANGE_DEG_S = 1.5
const MIN_FIT_SAMPLES = 3
// At full command; below this the axis is treated as unresponsive. Lowered alongside
// PROBE_RATE_CHANGE_DEG_S so a real but weak torque authority (heavy ship, small RCS) still counts
// instead of being indistinguishable from noise.
const MIN_ACCEL_DEG_S2 = 0.02
const MAX_SEGMENT_MISMATCH = 5 // + and − segment accelerations must agree within this ratio

interface Sample {
  t: number
  rate: number
}

class AxisProbe {
  private segment = 0 // 0: +100%, 1: −100%, 2: done
  private segmentStartedAt = 0
  private plusSegmentMs = MAX_PROBE_SEGMENT_MS
  private startRate: number | null = null
  private latestRate: number | null = null
  private current: Sample[] = []
  private fitted: Sample[][] = [[], []]

  constructor(nowMs: number) {
    this.segmentStartedAt = nowMs
  }

  get done(): boolean {
    return this.segment > 1
  }

  record(nowMs: number, rate: number): void {
    if (this.done) return
    this.startRate ??= rate
    this.latestRate = rate
    this.current.push({ t: nowMs, rate })
  }

  command(nowMs: number): number {
    const elapsed = nowMs - this.segmentStartedAt
    if (this.segment === 0 && elapsed >= MIN_PROBE_SEGMENT_MS) {
      const moved = this.startRate !== null && this.latestRate !== null && Math.abs(this.latestRate - this.startRate) >= PROBE_RATE_CHANGE_DEG_S
      if (moved || elapsed >= MAX_PROBE_SEGMENT_MS) {
        this.plusSegmentMs = elapsed
        this.endSegment(nowMs)
      }
    } else if (this.segment === 1 && elapsed >= this.plusSegmentMs) {
      this.endSegment(nowMs)
    }
    return this.segment === 0 ? MAX_COMMAND : this.segment === 1 ? -MAX_COMMAND : 0
  }

  private endSegment(nowMs: number): void {
    // Fit only the second half of each segment; the first half absorbs command latency.
    const halfway = this.segmentStartedAt + (nowMs - this.segmentStartedAt) / 2
    this.fitted[this.segment] = this.current.filter((s) => s.t >= halfway)
    this.current = []
    this.segment++
    this.segmentStartedAt = nowMs
  }

  gain(): number | null {
    const up = slope(this.fitted[0])
    const down = slope(this.fitted[1])
    if (up === null || down === null) return null
    const upGain = up / MAX_COMMAND
    const downGain = down / -MAX_COMMAND
    const small = Math.min(Math.abs(upGain), Math.abs(downGain))
    const consistent =
      Math.sign(upGain) === Math.sign(downGain) &&
      Math.min(Math.abs(up), Math.abs(down)) >= MIN_ACCEL_DEG_S2 &&
      Math.max(Math.abs(upGain), Math.abs(downGain)) <= MAX_SEGMENT_MISMATCH * small
    return consistent ? (upGain + downGain) / 2 : null
  }
}

/**
 * Measures each axis's torque authority directly (it depends on ship size/mass, so it can't be a
 * constant): a +100% / −100% doublet per RCS axis, fitting the angular-rate slope of each segment.
 * Axes are timed independently so an agile axis stops early instead of spinning up while a sluggish
 * or unresponsive one is still being probed. The doublet leaves each rate where it started and only
 * nudges the attitude slightly.
 */
export class RcsCalibrator {
  private probes: Record<RcsAxis, AxisProbe> | null = null

  start(nowMs: number): void {
    this.probes = { yaw: new AxisProbe(nowMs), pitch: new AxisProbe(nowMs), roll: new AxisProbe(nowMs) }
  }

  record(nowMs: number, rates: AxisValues): void {
    if (!this.probes) return
    for (const axis of RCS_AXES) this.probes[axis].record(nowMs, rates[axis])
  }

  /** Commands to send now; call only when they will actually be sent, since segment timing starts at send. */
  command(nowMs: number): { values: AxisValues; done: boolean } {
    const values: AxisValues = { yaw: 0, pitch: 0, roll: 0 }
    if (!this.probes) return { values, done: true }
    for (const axis of RCS_AXES) values[axis] = this.probes[axis].command(nowMs)
    return { values, done: RCS_AXES.every((axis) => this.probes![axis].done) }
  }

  gains(): AxisGains {
    return {
      yaw: this.probes?.yaw.gain() ?? null,
      pitch: this.probes?.pitch.gain() ?? null,
      roll: this.probes?.roll.gain() ?? null,
    }
  }
}

function slope(samples: Sample[]): number | null {
  if (samples.length < MIN_FIT_SAMPLES) return null
  const t0 = samples[0].t
  const n = samples.length
  let st = 0, sr = 0, stt = 0, str = 0
  for (const s of samples) {
    const t = (s.t - t0) / 1000
    st += t
    sr += s.rate
    stt += t * t
    str += t * s.rate
  }
  const denom = n * stt - st * st
  return denom > 0 ? (n * str - st * sr) / denom : null
}
