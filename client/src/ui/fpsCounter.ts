const SAMPLE_INTERVAL_MS = 500

export class FpsCounter {
  private el: HTMLDivElement
  private frames = 0
  private windowStart = performance.now()

  constructor(container: HTMLElement) {
    this.el = document.createElement("div")
    this.el.className = "hud-panel hud-fps"
    container.appendChild(this.el)
  }

  /** Call once per rendered frame. */
  tick(): void {
    this.frames++
    const now = performance.now()
    const elapsed = now - this.windowStart
    if (elapsed >= SAMPLE_INTERVAL_MS) {
      const fps = (this.frames * 1000) / elapsed
      this.el.textContent = `${fps.toFixed(0)} FPS`
      this.frames = 0
      this.windowStart = now
    }
  }
}
