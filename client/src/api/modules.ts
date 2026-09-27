export type ModuleTab = "cargo" | "propulsion" | "armaments" | "crafting"

export const TAB_LABELS: Record<ModuleTab, string> = {
  cargo: "Cargo & Storage",
  propulsion: "Propulsione",
  armaments: "Armamenti",
  crafting: "Crafting",
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

const PROPULSION_TYPES = new Set(["FixedThruster", "RcsThruster", "SteeringThruster", "FuelCell"])
const ARMAMENT_TYPES = new Set(["Turret", "Mine"])
const CARGO_TYPES = new Set(["Cargo"])

// component-catalog.json calls it "SystemMap"; a live entity from the currently-running
// server still tags it "StarMap" (that build predates the rename in system_map.rs) — accept
// both until the server gets rebuilt/restarted with the current source.
export const SYSTEM_MAP_TYPES = new Set(["SystemMap", "StarMap"])

export function tabForModuleType(type: string): ModuleTab | null {
  if (CARGO_TYPES.has(type)) return "cargo"
  if (PROPULSION_TYPES.has(type)) return "propulsion"
  if (ARMAMENT_TYPES.has(type)) return "armaments"
  if (CRAFTING_TYPES.has(type)) return "crafting"
  return null
}
