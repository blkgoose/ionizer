import { ionClient } from "../api/client"
import type { FloatingOriginPosition, ShipEntity, Vector3 } from "../api/types"

// floating_origin.rs ORIGIN_SECTOR_SIZE_M — not part of the public API spec, mirrored here
// because relative distances between the ship and system-map entries (up to 1 ly apart) span
// many sectors and can't be computed correctly from `shift` alone.
const SECTOR_SIZE_M = 1e11

export interface ModuleRef {
  module_id: string
  type: string
}

/**
 * Real GET shape (confirmed against a running server): position lives at
 * body.position.position ({sector, shift} — see floating_origin.rs). modules is a
 * map keyed by module_id, not an array.
 */
export function readFloatingPosition(entity: ShipEntity): FloatingOriginPosition | null {
  const pos = (entity as any)?.body?.position?.position
  if (pos?.sector && pos?.shift) return pos as FloatingOriginPosition
  return null
}

/** Ship's own shift, ignoring sector — fine for placing the camera and nearby (same-sector) radar contacts. */
export function readPosition(entity: ShipEntity): [number, number, number] {
  const shift = readFloatingPosition(entity)?.shift
  if (shift) return [shift.x, shift.y, shift.z]
  return [0, 0, 0]
}

/** `to` relative to `from`, correct across sector boundaries (unlike subtracting shift alone). */
export function relativeVector(from: FloatingOriginPosition, to: FloatingOriginPosition): [number, number, number] {
  return [
    (to.sector.x - from.sector.x) * SECTOR_SIZE_M + (to.shift.x - from.shift.x),
    (to.sector.y - from.sector.y) * SECTOR_SIZE_M + (to.shift.y - from.shift.y),
    (to.sector.z - from.sector.z) * SECTOR_SIZE_M + (to.shift.z - from.shift.z),
  ]
}

export interface OrientationQuaternion {
  q: number
  x: number
  y: number
  z: number
}

/** body.rotation.orientation — {q,x,y,z}, q is the scalar/w component. */
export function readOrientation(entity: ShipEntity): OrientationQuaternion | null {
  const o = (entity as any)?.body?.rotation?.orientation
  if (o && typeof o.q === "number") return o as OrientationQuaternion
  return null
}

export function readVelocity(entity: ShipEntity): Vector3 | null {
  const v = (entity as any)?.body?.position?.velocity
  if (v && typeof v.x === "number") return v as Vector3
  return null
}

/** body.rotation.velocity — angular velocity, rad/s per axis (ship's local frame). */
export function readAngularVelocity(entity: ShipEntity): Vector3 | null {
  const v = (entity as any)?.body?.rotation?.velocity
  if (v && typeof v.x === "number") return v as Vector3
  return null
}

/** Reads a module's live `activation` straight off GET's modules map (no MAN round-trip needed). */
export function readModuleActivation(entity: ShipEntity, moduleId: string): number | null {
  return readModuleField(entity, moduleId, "activation")
}

/** Reads an arbitrary numeric field straight off GET's modules map (no MAN round-trip needed). */
export function readModuleField(entity: ShipEntity, moduleId: string, field: string): number | null {
  const m = (entity as any)?.modules?.[moduleId]
  const v = m?.[field]
  return typeof v === "number" ? v : null
}

export interface EngineActivation {
  moduleId: string
  type: string
  activation: number
}

export function readEngineActivations(entity: ShipEntity, modules: ModuleRef[]): EngineActivation[] {
  return modules
    .filter((m) => m.type === "FixedThruster" || m.type === "SteeringThruster")
    .map((m) => ({ moduleId: m.module_id, type: m.type, activation: readModuleActivation(entity, m.module_id) ?? 0 }))
}

export function readModules(entity: ShipEntity): ModuleRef[] {
  const modules = entity["modules"]
  if (modules && typeof modules === "object" && !Array.isArray(modules)) {
    return Object.entries(modules as Record<string, { type?: unknown }>)
      .filter((entry): entry is [string, { type: string }] => typeof entry[1]?.type === "string")
      .map(([module_id, value]) => ({ module_id, type: value.type }))
  }
  return []
}

type Listener = (entity: ShipEntity) => void

export class ShipStatePoller {
  private listeners = new Set<Listener>()
  private latest: ShipEntity | null = null
  private running = false
  private rafHandle: number | undefined

  /**
   * Driven by requestAnimationFrame instead of a fixed setInterval: fires a new GET every
   * rendered frame (matching the display's refresh rate, ~60fps) as long as the previous one has
   * already resolved — never overlapping requests, but never waiting longer than a frame either.
   */
  start(): void {
    if (this.running) return
    this.running = true

    const loop = () => {
      if (!this.running) return
      this.rafHandle = requestAnimationFrame(loop)
      void this.poll()
    }
    loop()
  }

  private inFlight = false

  private async poll(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const entity = await ionClient.get()
      this.latest = entity
      this.listeners.forEach((listener) => listener(entity))
    } catch (err) {
      console.error("GET poll failed", err)
    } finally {
      this.inFlight = false
    }
  }

  stop(): void {
    this.running = false
    if (this.rafHandle !== undefined) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = undefined
    }
  }

  getLatest(): ShipEntity | null {
    return this.latest
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const shipStatePoller = new ShipStatePoller()
