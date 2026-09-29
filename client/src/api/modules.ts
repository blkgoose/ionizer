import { MAIN_THRUSTER_TYPES } from "../state/shipState"

export type ModuleTab = "cargo" | "propulsion" | "armaments" | "crafting" | "docking" | "hull"

export const TAB_LABELS: Record<ModuleTab, string> = {
  cargo: "Cargo & Storage",
  propulsion: "Spostamento",
  armaments: "Armamenti",
  crafting: "Crafting",
  docking: "Docking",
  hull: "Scafo",
}

const CRAFTING_TYPES = new Set([
  "Assembler",
  "ChemicalAssembler",
  "ColdForge",
  "FDMPrinter",
  "Furnace",
  "HydraulicPress",
  "PCBMaker",
  "PhotolithographyScanner",
  "Polymerizer",
  "Shaper",
  "SheetMaker",
  "Smelter",
  "TubeWelder",
  "WaferSlicer",
  "WireExtruder",
  "WireWinder",
])

const PROPULSION_TYPES = new Set([...MAIN_THRUSTER_TYPES, "RcsThruster", "SteeringThruster", "FuelCell"])
const ARMAMENT_TYPES = new Set(["Turret", "Mine"])
const CARGO_TYPES = new Set(["Cargo"])
const DOCKING_TYPES = new Set(["DockingPort", "DockingController"])
const HULL_TYPES = new Set(["LightHull", "StandardHull", "HeavyHull"])

// component-catalog.json calls it "SystemMap"; a live entity from the currently-running
// server still tags it "StarMap" (that build predates the rename in system_map.rs) — accept
// both until the server gets rebuilt/restarted with the current source.
export const SYSTEM_MAP_TYPES = new Set(["SystemMap", "StarMap"])
export const RADAR_TYPES = new Set(["Radar"])

export function tabForModuleType(type: string): ModuleTab | null {
  if (CARGO_TYPES.has(type)) return "cargo"
  if (PROPULSION_TYPES.has(type)) return "propulsion"
  if (ARMAMENT_TYPES.has(type)) return "armaments"
  if (CRAFTING_TYPES.has(type)) return "crafting"
  if (DOCKING_TYPES.has(type)) return "docking"
  if (HULL_TYPES.has(type)) return "hull"
  return null
}
