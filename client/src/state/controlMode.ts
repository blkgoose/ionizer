export type ControlMode = "cockpit" | "tactical"

const STORAGE_KEY = "ion.controlMode"

export function getControlMode(): ControlMode {
  return sessionStorage.getItem(STORAGE_KEY) === "tactical" ? "tactical" : "cockpit"
}

export function setControlMode(mode: ControlMode): void {
  sessionStorage.setItem(STORAGE_KEY, mode)
}
