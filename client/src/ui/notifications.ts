const DEFAULT_DURATION_MS = 6000

/**
 * Small toast stack for events that would otherwise happen silently — an auto-disengage the
 * player didn't trigger (target lost, calibration failure, …) previously left no trace beyond a
 * console.warn, so the autopilot status just vanished with no explanation. Anything that disengages
 * or otherwise cancels a player action on its own should notify through here instead.
 */
export class Notifications {
  private el: HTMLDivElement

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "notifications"
    container.appendChild(this.el)
  }

  show(message: string, durationMs = DEFAULT_DURATION_MS): void {
    const item = document.createElement("div")
    item.className = "notification"
    item.textContent = message
    this.el.appendChild(item)
    window.setTimeout(() => item.remove(), durationMs)
  }
}
