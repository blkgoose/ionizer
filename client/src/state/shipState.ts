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

/** body.size — entity.rs's contact_radius uses this /2 as the collider radius; here, the ship's own real diameter, meters. */
export function readShipSize(entity: ShipEntity): number | null {
  const size = (entity as any)?.body?.size
  return typeof size === "number" ? size : null
}

/** body.mass — entity.rs's mass_and_size sums dry module mass plus whatever fuel is left, so this drifts down as thrusters burn fuel. */
export function readShipMass(entity: ShipEntity): number | null {
  const mass = (entity as any)?.body?.mass
  return typeof mass === "number" ? mass : null
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

// fuelcell.rs's FUEL_CAPACITY_KG — not part of the public API spec, mirrored here to turn
// fuel_kg into a percentage for the gauge.
export const FUEL_CAPACITY_KG = 50_000

export interface FuelLevel {
  moduleId: string
  fuelKg: number
}

export function readFuelLevels(entity: ShipEntity, modules: ModuleRef[]): FuelLevel[] {
  return modules
    .filter((m) => m.type === "FuelCell")
    .map((m) => ({ moduleId: m.module_id, fuelKg: readModuleField(entity, m.module_id, "fuel_kg") ?? 0 }))
}

// SteeringThruster.yaw is the mount's fixed firing direction in the ship's local frame, degrees,
// 0 = same as a FixedThruster (forward). Bucketing to the nearest cardinal tells us what role a
// given mount actually plays instead of guessing from list order. Shared by manual propulsion
// (propulsion.ts) and the autopilot (autopilot.ts) so both agree on which thruster does what.
const YAW_BUCKETS = [0, 90, 180, 270] as const
type YawBucket = (typeof YAW_BUCKETS)[number]

function nearestYawBucket(yaw: number): YawBucket {
  const normalized = ((yaw % 360) + 360) % 360
  let best: YawBucket = 0
  let bestDist = Infinity
  for (const bucket of YAW_BUCKETS) {
    const dist = Math.min(Math.abs(normalized - bucket), 360 - Math.abs(normalized - bucket))
    if (dist < bestDist) {
      bestDist = dist
      best = bucket
    }
  }
  return best
}

export interface ThrusterGroups {
  rcs: ModuleRef[]
  fixed: ModuleRef[]
  retro: ModuleRef[]
  lateralQ: ModuleRef[]
  lateralE: ModuleRef[]
}

export function classifyThrusters(entity: ShipEntity | null, modules: ModuleRef[]): ThrusterGroups {
  const groups: ThrusterGroups = { rcs: [], fixed: [], retro: [], lateralQ: [], lateralE: [] }

  for (const m of modules) {
    if (m.type === "RcsThruster") groups.rcs.push(m)
    else if (m.type === "FixedThruster") groups.fixed.push(m)
    else if (m.type === "SteeringThruster") {
      const yaw = entity ? (readModuleField(entity, m.module_id, "yaw") ?? 0) : 0
      switch (nearestYawBucket(yaw)) {
        case 180:
          groups.retro.push(m)
          break
        case 90:
          groups.lateralQ.push(m)
          break
        case 270:
          groups.lateralE.push(m)
          break
        default:
          // yaw ~0: fires the same direction as a FixedThruster, no lateral/retro role to assign.
          break
      }
    }
  }

  return groups
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

// Matches the server's own physics tick rate (15 tps) — polling faster than the server actually
// advances state just burns requests on repeats of the same tick.
const POLL_INTERVAL_MS = 1000 / 15

export class ShipStatePoller {
  private listeners = new Set<Listener>()
  private latest: ShipEntity | null = null
  private running = false
  private rafHandle: number | undefined
  private lastPollAt = 0

  /**
   * Driven by requestAnimationFrame (so it's paused/throttled by the browser the same way
   * rendering is) but self-throttled to POLL_INTERVAL_MS — never overlapping requests, and never
   * firing faster than the server can actually produce new state.
   */
  start(): void {
    if (this.running) return
    this.running = true

    const loop = (now: number) => {
      if (!this.running) return
      this.rafHandle = requestAnimationFrame(loop)
      if (now - this.lastPollAt >= POLL_INTERVAL_MS) {
        this.lastPollAt = now
        void this.poll()
      }
    }
    this.rafHandle = requestAnimationFrame(loop)
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
