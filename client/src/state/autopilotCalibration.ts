import type { AxisGains } from "../scene/attitude"

const STORAGE_KEY = "ion.autopilot.calibration"

// Fuel burns continuously (fuelcell.rs's mass() includes whatever propellant is left), so
// body.mass drifts down every time a thruster fires — requiring an exact match would recalibrate
// on essentially every engage. A few % of mass barely changes moment of inertia (and therefore
// the measured deg/s² per % gain), so tolerate drift up to this fraction before treating the ship
// as "changed" and recalibrating for real.
const MASS_TOLERANCE_FRACTION = 0.05

/**
 * A calibration is only valid for the exact set of RCS thrusters it was measured on (module_ids,
 * see classifyThrusters) and a ship of roughly the same size/mass — both drive the moment of
 * inertia the gain is measured against (see rcs_thruster.rs's lever_arm_m and
 * entity.rs's moment_of_inertia_kg_m2).
 */
export interface StoredCalibration {
  rcsIds: string
  sizeM: number
  massKg: number
  gains: AxisGains
}

/**
 * Persisted in localStorage (unlike api/client.ts's session token or autopilotGoal.ts's in-flight
 * goal, both sessionStorage) because a calibration is a physical fact about the ship's actual
 * hardware, not something tied to a login session — it stays valid across tabs and browser
 * restarts as long as the same ship's RCS loadout and mass/size haven't changed.
 */
export function loadAutopilotCalibration(): StoredCalibration | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredCalibration
  } catch {
    return null
  }
}

export function saveAutopilotCalibration(calibration: StoredCalibration): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration))
}

/** Whether `stored` can be reused as-is for a ship currently reporting `rcsIds`/`sizeM`/`massKg`. */
export function calibrationMatches(stored: StoredCalibration, rcsIds: string, sizeM: number, massKg: number): boolean {
  if (stored.rcsIds !== rcsIds) return false
  if (stored.sizeM !== sizeM) return false
  const massDelta = Math.abs(stored.massKg - massKg) / stored.massKg
  return massDelta <= MASS_TOLERANCE_FRACTION
}
