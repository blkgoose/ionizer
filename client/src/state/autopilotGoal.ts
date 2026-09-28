import type { FloatingOriginPosition } from "../api/types"

const STORAGE_KEY = "ion.autopilot"

/**
 * Serializable description of whatever the autopilot is currently doing — enough to re-derive the
 * live `getTargetPosition` closure autopilot.engage() needs (see resolveAutopilotGoal in main.ts),
 * without persisting the closure itself.
 */
export type AutopilotGoal =
  | { kind: "shipApproach"; entityId: string; arrivalRadius: number; targetRadiusM: number; label: string; pointOnly?: boolean }
  | { kind: "bodyApproach"; entryIndex: number; arrivalRadius: number; targetRadiusM: number; label: string; pointOnly?: boolean }
  | { kind: "orbit"; center: FloatingOriginPosition; radiusM: number; arrivalRadius: number; startedAtMs: number; label: string }
  | { kind: "stop" }

/**
 * Persists the in-progress autopilot goal across a page refresh, the same way api/client.ts keeps
 * the session token in sessionStorage (survives reload, cleared when the tab closes). Without this,
 * reloading mid-maneuver drops the Autopilot instance — and with it the only thing still zeroing the
 * RCS/engines — while the ship keeps whatever rotation/velocity it had, with nothing to correct it.
 */
export function loadAutopilotGoal(): AutopilotGoal | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AutopilotGoal
  } catch {
    return null
  }
}

export function saveAutopilotGoal(goal: AutopilotGoal | null): void {
  if (goal) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(goal))
  else sessionStorage.removeItem(STORAGE_KEY)
}
