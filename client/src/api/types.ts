export interface VariableManifest {
  name: string
  type: string
  value: unknown
  mutable: boolean
  constraints?: Record<string, unknown> | null
  description: string
}

export interface ActionParamManifest {
  name: string
  type: string
  description: string
}

export interface ActionManifest {
  name: string
  params: ActionParamManifest[]
  cooldown_s: number
  description: string
}

export interface ModuleManifest {
  module_id: string
  type: string
  description: string
  health_pct: number
  mass_kg: number
  volume_m3: number
  variables: VariableManifest[]
  actions: ActionManifest[]
}

export interface ShipEntity {
  [key: string]: unknown
}

export interface Vector3 {
  x: number
  y: number
  z: number
}

export interface SectorIndex {
  x: number
  y: number
  z: number
}

/** Matches ion-og's floating_origin.rs FloatingOriginPosition: a coarse sector index (1e11m each) + a fine shift within it. */
export interface FloatingOriginPosition {
  sector: SectorIndex
  shift: Vector3
}

export interface SystemMapEntry {
  kind: "star" | "planet" | string
  position: FloatingOriginPosition
  diameter_m: number
}

/** Radar.scan's ActionResult::ScanResult — a Rust tuple, serialized as a 3-element JSON array. */
export type RadarContactEntry = [entityId: string, position: FloatingOriginPosition, size: number]

export class IonCommandError extends Error {}
