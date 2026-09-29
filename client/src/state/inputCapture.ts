// Shared flag so movement/camera key handlers (currently just TacticalCameraController) can
// ignore their own bindings while a keyboard-driven modal is capturing the same keys for its own
// navigation — e.g. CommandPalette's arrow-key list navigation would otherwise also pan the
// tactical camera and break its auto-follow of the ship underneath it (the ship then "disappears"
// since the camera stops tracking it).
let captured = false

export function setInputCaptured(value: boolean): void {
  captured = value
}

export function isInputCaptured(): boolean {
  return captured
}
