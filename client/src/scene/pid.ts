/**
 * Standard PID with a clamped integral term (anti-windup) — the integral only accumulates while
 * the output isn't already saturated, so it can't keep building up while the RCS is maxed out
 * and overshoot the target once it finally has authority again.
 */
export class PidController {
  private integral = 0
  private kp: number
  private ki: number
  private kd: number
  private outputLimit: number
  private integralLimit: number

  constructor(kp: number, ki: number, kd: number, outputLimit: number, integralLimit: number) {
    this.kp = kp
    this.ki = ki
    this.kd = kd
    this.outputLimit = outputLimit
    this.integralLimit = integralLimit
  }

  reset(): void {
    this.integral = 0
  }

  /** Retunes gains in place (e.g. when the ship's actual thruster count changes) without discarding the accumulated integral. */
  setGains(kp: number, ki: number, kd: number): void {
    this.kp = kp
    this.ki = ki
    this.kd = kd
  }

  /** `rate` is the measured rate of change of the controlled quantity (not of `error`) — using a direct sensor reading instead of differencing `error` avoids derivative kick from noisy/step changes in the target. */
  update(error: number, rate: number, dtSeconds: number): number {
    const unclamped = this.kp * error - this.kd * rate + this.ki * this.integral
    const saturated = unclamped > this.outputLimit || unclamped < -this.outputLimit
    if (!saturated) {
      this.integral = Math.max(-this.integralLimit, Math.min(this.integralLimit, this.integral + error * dtSeconds))
    }
    return Math.max(-this.outputLimit, Math.min(this.outputLimit, unclamped))
  }
}
