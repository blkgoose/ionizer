import type { AutopilotPhase } from "../scene/autopilot"

const STORAGE_KEY = "ion.autopilot.phase"

const VALID_PHASES: readonly AutopilotPhase[] = [
  "idle",
  "tuning",
  "pointing",
  "burning",
  "stoppingBurner",
  "reverse",
  "stopping",
  "fineStop",
]

/**
 * Persisted in localStorage, not sessionStorage like autopilotGoal.ts's in-flight goal — a refresh
 * re-engages the same goal from scratch (tuning, then pointing), which is harmless most of the
 * time but actively wrong mid-maneuver: losing "reverse"/"stopping" back to "pointing" would aim
 * the ship at the target again and re-burn forward instead of finishing the retrograde brake it
 * was already committed to. Storing the phase separately lets Autopilot.resumePhase() fast-forward
 * straight back to where it left off (see main.ts's pendingResume handling).
 */
export function loadAutopilotPhase(): AutopilotPhase | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw || !(VALID_PHASES as readonly string[]).includes(raw)) return null
  return raw as AutopilotPhase
}

export function saveAutopilotPhase(phase: AutopilotPhase | null): void {
  if (phase && phase !== "idle") localStorage.setItem(STORAGE_KEY, phase)
  else localStorage.removeItem(STORAGE_KEY)
}
