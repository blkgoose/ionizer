const RELAY_AMPLITUDE = 100 // pct output while relaying — the classic method drives the plant at max effort
const MIN_CYCLES = 3 // full oscillation cycles to average before trusting the identified period/amplitude
const MAX_TUNE_DURATION_MS = 15000 // safety bail-out if the loop never settles into a clean oscillation
// Ship state polls at ~15/s (~66ms/tick). A relay switching on bare sign(error) flips the instant
// noise crosses zero, which — at this sample rate — either miscounts crossings (corrupting the
// measured period) or, for a fast/light ship, can complete "cycles" too small to be measured at
// all within a tick, both of which were causing the tuner to either never finish cleanly or hand
// back garbage gains. A small dead zone around zero means the relay only flips once the error has
// genuinely swung to the other side, giving a much cleaner square wave to measure.
const RELAY_HYSTERESIS_DEG = 1.5
// Below this, an observed "oscillation" is on the order of sensor/relay noise rather than a real
// plant swing — trusting its amplitude produces a huge (and wrong) Ku, which is what was causing
// installed gains to be too aggressive and overshoot despite having just "tuned".
const MIN_TRUSTED_AMPLITUDE_DEG = 2

export interface PidGains {
  kp: number
  ki: number
  kd: number
}

/**
 * Åström–Hägglund relay-feedback auto-tuner: instead of guessing PID gains, briefly drives the
 * real plant with a bang-bang relay (full command in the direction that reduces the live error)
 * and watches the resulting oscillation. Once enough cycles are captured, the oscillation's
 * period and amplitude identify the plant's ultimate gain/period, from which classic
 * Ziegler–Nichols gives Kp/Ki/Kd tuned to *this* actual ship (mass, thruster count, everything) —
 * not a fixed guess that then needs manual re-tuning per configuration.
 */
export class RelayAutoTuner {
  private startedAtMs: number | null = null
  private lastSign: number | null = null
  private relayCommand = RELAY_AMPLITUDE
  private crossingTimes: number[] = []
  private peaks: number[] = []
  private currentPeak = 0
  private currentPeakSign = 0

  get running(): boolean {
    return this.startedAtMs !== null
  }

  start(nowMs: number): void {
    this.startedAtMs = nowMs
    this.lastSign = null
    this.relayCommand = RELAY_AMPLITUDE
    this.crossingTimes = []
    this.peaks = []
    this.currentPeak = 0
    this.currentPeakSign = 0
  }

  /**
   * Feed the live error each tick. Returns the relay command to apply this tick, whether the test
   * is finished, and the identified gains (null if it bailed out without a clean oscillation).
   */
  step(errorDeg: number, nowMs: number): { command: number; done: boolean; gains: PidGains | null } {
    if (this.startedAtMs === null) return { command: 0, done: true, gains: null }

    // Only flip the relay once the error has genuinely crossed to the other side of a dead zone —
    // see RELAY_HYSTERESIS_DEG for why bare sign(error) was unreliable at this sample rate.
    if (this.relayCommand > 0 && errorDeg < -RELAY_HYSTERESIS_DEG) this.relayCommand = -RELAY_AMPLITUDE
    else if (this.relayCommand < 0 && errorDeg > RELAY_HYSTERESIS_DEG) this.relayCommand = RELAY_AMPLITUDE
    const sign = this.relayCommand > 0 ? 1 : -1

    // Track the peak |error| of the current half-cycle — these become the relay-feedback
    // amplitude estimate once we have a few full swings.
    if (sign === this.currentPeakSign) {
      this.currentPeak = Math.max(this.currentPeak, Math.abs(errorDeg))
    } else {
      if (this.currentPeakSign !== 0) this.peaks.push(this.currentPeak)
      this.currentPeakSign = sign
      this.currentPeak = Math.abs(errorDeg)
    }

    if (this.lastSign !== null && sign !== this.lastSign) {
      this.crossingTimes.push(nowMs)
    }
    this.lastSign = sign

    const elapsed = nowMs - this.startedAtMs
    const haveEnoughCycles = this.crossingTimes.length >= MIN_CYCLES * 2 + 1
    if (haveEnoughCycles || elapsed > MAX_TUNE_DURATION_MS) {
      const gains = this.computeGains()
      this.startedAtMs = null
      return { command: 0, done: true, gains }
    }

    return { command: this.relayCommand, done: false, gains: null }
  }

  private computeGains(): PidGains | null {
    if (this.crossingTimes.length < 3 || this.peaks.length < 2) return null

    // Ultimate period: average spacing between every-other zero-crossing (one full period apart).
    const periodsSeconds: number[] = []
    for (let i = 2; i < this.crossingTimes.length; i++) {
      periodsSeconds.push((this.crossingTimes[i] - this.crossingTimes[i - 2]) / 1000)
    }
    const Tu = periodsSeconds.reduce((sum, p) => sum + p, 0) / periodsSeconds.length

    // Skip the first (possibly partial, pre-oscillation) peak.
    const settledPeaks = this.peaks.slice(1)
    const amplitude = settledPeaks.reduce((sum, p) => sum + p, 0) / settledPeaks.length

    if (!(Tu > 0) || !(amplitude >= MIN_TRUSTED_AMPLITUDE_DEG)) return null

    // Describing-function estimate of the ultimate gain for an ideal relay, then a conservative
    // PD-only tuning from (Ku, Tu). No integral term: the pointing plant (torque -> angular accel
    // -> rate -> angle) is a frictionless double integrator with no steady-state disturbance torque
    // to cancel, so Ki has nothing to correct and only costs phase margin — a nonzero Ki here was
    // the actual cause of a sustained, never-settling oscillation no matter how P/D were tuned.
    const Ku = (4 * RELAY_AMPLITUDE) / (Math.PI * amplitude)
    const kp = 0.2 * Ku
    const ki = 0
    const kd = (kp * Tu) / 3

    return { kp, ki, kd }
  }
}
