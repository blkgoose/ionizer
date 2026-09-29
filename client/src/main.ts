import * as THREE from "three"
import "./style.css"
import { ionClient } from "./api/client"
import { RADAR_TYPES, SYSTEM_MAP_TYPES, TAB_LABELS, tabForModuleType } from "./api/modules"
import { renderLogin } from "./ui/login"
import { Hud } from "./ui/hud"
import { ModulesModal } from "./ui/modulesModal"
import { Minimap } from "./ui/minimap"
import { SystemPanel, formatDistance } from "./ui/systemPanel"
import { RadarPanel } from "./ui/radarPanel"
import { OrientationPanel } from "./ui/orientationPanel"
import { DirectionMarkers } from "./ui/directionMarkers"
import { FpsCounter } from "./ui/fpsCounter"
import { CommandPalette, type PaletteItem, type PaletteNode } from "./ui/commandPalette"
import { AutopilotStatus } from "./ui/autopilotStatus"
import { Notifications } from "./ui/notifications"
import { FlightScene } from "./scene/scene"
import { Starfield } from "./scene/starfield"
import { IntelligentPropulsion } from "./scene/propulsion"
import { TacticalCameraController } from "./scene/tacticalCamera"
import { autopilot, orbitTargetPosition, safeOrbitRadiusM } from "./scene/autopilot"
import { getControlMode } from "./state/controlMode"
import {
  shipStatePoller,
  readPosition,
  readFloatingPosition,
  readModules,
  readOrientation,
  readEngineActivations,
  readFuelLevels,
  readShipSize,
  readVelocity,
  relativeVector,
  type ModuleRef,
} from "./state/shipState"
import { systemMapPoller } from "./state/systemMap"
import { radarPoller } from "./state/radar"
import type { FloatingOriginPosition } from "./api/types"
import { loadAutopilotGoal, saveAutopilotGoal, type AutopilotGoal } from "./state/autopilotGoal"
import { loadAutopilotPhase } from "./state/autopilotPhase"

const PROPULSION_TICK_MS = 100
const RENDER_INTERVAL_MS = 1000 / 15
const ARRIVAL_RADIUS_M = 200
const DEFAULT_CRUISE_SPEED_MPS = 1000

/** Parses the command palette's "Approach" cruise-speed prompt; falls back to the default on blank/invalid input. */
function parseCruiseSpeed(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CRUISE_SPEED_MPS
}

const app = document.querySelector<HTMLDivElement>("#app")!

function startGame(): void {
  app.innerHTML = ""

  const tactical = getControlMode() === "tactical"

  const scene = new FlightScene(app)
  const starfield = new Starfield(scene.scene)
  const hud = new Hud(
    app,
    () => {
      ionClient.logout()
      location.reload()
    },
    () => engageAutopilot({ kind: "stop" }),
  )
  const modal = new ModulesModal(app)
  const minimap = new Minimap(app)
  const systemPanel = new SystemPanel(app, (entryIndex, kind) => {
    const position = systemMapPoller.getLatest()[entryIndex]?.position ?? null
    showBodyMenu(entryIndex, kind, position)
  })
  const radarPanel = new RadarPanel(app, (entityId) => {
    showShipMenu(entityId)
  })
  const orientationPanel = new OrientationPanel(app)
  const directionMarkers = new DirectionMarkers(app)
  const fpsCounter = new FpsCounter(app)
  const propulsion = new IntelligentPropulsion()
  const commandPalette = new CommandPalette(app, buildCommandPaletteRoot)

  // Tactical mode flies exclusively via the autopilot (mouse targeting + context menu), so
  // manual keyboard thruster control stands down entirely — WASD/arrows are the camera's pan
  // input there instead (see TacticalCameraController).
  propulsion.enabled = !tactical
  const tacticalCamera = tactical ? new TacticalCameraController(scene.camera, scene.renderer.domElement) : null

  let currentModules: ModuleRef[] = []
  // Tracked purely for the tactical camera's auto-orient (see below) — the autopilot itself
  // already has its own live target via engageAutopilot()'s closure.
  let activeGoal: AutopilotGoal | null = null

  function disengageAutopilot(): void {
    autopilot.disengage()
    propulsion.enabled = !tactical
    saveAutopilotGoal(null)
    activeGoal = null
  }

  const autopilotStatus = new AutopilotStatus(app, disengageAutopilot)
  const notifications = new Notifications(app)
  autopilot.onFailure((reason) => notifications.show(`Autopilota disattivato: ${reason}`))

  if (tacticalCamera) {
    const raycaster = new THREE.Raycaster()
    // Faint, sparse wireframe sphere marking whatever was actually hit, so hovering shows where
    // a click will register (stars/planets/ships are tiny, hard-to-hit skybox dots otherwise).
    // Coarse segment count and low opacity keep it a subtle cue rather than a glowing cage.
    const hoverHighlight = new THREE.Mesh(
      new THREE.SphereGeometry(1, 8, 5),
      new THREE.MeshBasicMaterial({ color: 0x7ac4dd, wireframe: true, transparent: true, opacity: 0.18 }),
    )
    hoverHighlight.visible = false
    scene.scene.add(hoverHighlight)

    type HoveredPickable = { kind: "ship"; entityId: string; object: THREE.Object3D } | { kind: "body"; entryIndex: number; bodyKind: string; object: THREE.Object3D }

    function findHovered(clientX: number, clientY: number): HoveredPickable | null {
      const rect = scene.renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, scene.camera)

      const contactPickables = scene.getContactPickables()
      const starPickables = starfield.getPickables()
      const hits = raycaster.intersectObjects([...contactPickables.map((p) => p.object), ...starPickables.map((p) => p.object)], true)

      // Contacts are groups (body+tip+hit-target meshes as children) and starfield bodies are
      // leaf meshes sharing one parent group — in both cases the actual intersected object can be
      // a descendant of what we're looking for, so walk each hit up instead of assuming a fixed
      // hierarchy depth.
      for (const hit of hits) {
        let node: THREE.Object3D | null = hit.object
        while (node) {
          const contact = contactPickables.find((p) => p.object === node)
          if (contact) return { kind: "ship", entityId: contact.entityId, object: node }
          const star = starPickables.find((p) => p.object === node)
          if (star) return { kind: "body", entryIndex: star.entryIndex, bodyKind: star.kind, object: node }
          node = node.parent
        }
      }
      return null
    }

    scene.renderer.domElement.addEventListener("click", (event) => {
      const hovered = findHovered(event.clientX, event.clientY)
      if (!hovered) {
        commandPalette.close()
        return
      }
      if (hovered.kind === "ship") {
        showShipMenu(hovered.entityId)
      } else {
        const position = systemMapPoller.getLatest()[hovered.entryIndex]?.position ?? null
        showBodyMenu(hovered.entryIndex, hovered.bodyKind, position)
      }
    })

    scene.renderer.domElement.addEventListener("mousemove", (event) => {
      const hovered = findHovered(event.clientX, event.clientY)
      if (hovered) {
        const sphere = new THREE.Box3().setFromObject(hovered.object).getBoundingSphere(new THREE.Sphere())
        hoverHighlight.position.copy(sphere.center)
        // The hit-target meshes (scene.ts/starfield.ts) are deliberately oversized well beyond
        // the visible body to make clicking easier — shrink the highlight back down so it hugs
        // the object instead of ballooning out to that oversized hit-target's radius.
        hoverHighlight.scale.setScalar(sphere.radius * 0.6)
        hoverHighlight.visible = true
        scene.renderer.domElement.style.cursor = "pointer"
      } else {
        hoverHighlight.visible = false
        scene.renderer.domElement.style.cursor = "default"
      }
    })
  }

  /** Builds the live getTargetPosition closure for a persisted goal — the inverse of what each context-menu action below stores. */
  function resolveGoal(
    goal: Exclude<AutopilotGoal, { kind: "stop" }>,
  ): { getTarget: (nowMs: number) => FloatingOriginPosition | null; arrivalRadius: number; targetRadiusM: number; label: string } {
    switch (goal.kind) {
      case "shipApproach":
        return {
          getTarget: () => radarPoller.getLatest().find(([id]) => id === goal.entityId)?.[1] ?? null,
          arrivalRadius: goal.arrivalRadius,
          targetRadiusM: goal.targetRadiusM,
          label: goal.label,
        }
      case "bodyApproach":
        return {
          getTarget: () => systemMapPoller.getLatest()[goal.entryIndex]?.position ?? null,
          arrivalRadius: goal.arrivalRadius,
          targetRadiusM: goal.targetRadiusM,
          label: goal.label,
        }
      case "orbit":
        return {
          getTarget: orbitTargetPosition(goal.center, goal.radiusM, goal.startedAtMs),
          arrivalRadius: goal.arrivalRadius,
          targetRadiusM: 0,
          label: goal.label,
        }
    }
  }

  function engageAutopilot(goal: AutopilotGoal): void {
    propulsion.enabled = false
    autopilot.setModules(currentModules, shipStatePoller.getLatest())
    if (goal.kind === "stop") {
      autopilot.engageStop()
    } else {
      const { getTarget, arrivalRadius, targetRadiusM, label } = resolveGoal(goal)
      autopilot.engage(
        getTarget,
        arrivalRadius,
        targetRadiusM,
        label,
        goal.kind !== "orbit" && goal.pointOnly,
        goal.kind !== "orbit" ? goal.maxCruiseSpeedMps : undefined,
      )
    }
    saveAutopilotGoal(goal)
    activeGoal = goal
  }

  // Resumed once the relevant live position becomes available (radar/system-map poll not necessarily
  // caught up yet on the very first ship-state tick) — see the shipStatePoller.subscribe callback below.
  let pendingResume: AutopilotGoal | null = loadAutopilotGoal()

  function showShipMenu(entityId: string): void {
    const turretModule = currentModules.find((m) => m.type === "Turret")
    const shipPosition = readFloatingPosition(shipStatePoller.getLatest() ?? {})
    const contact = radarPoller.getLatest().find(([id]) => id === entityId)
    // radar.rs's Radar.scan reports `size` as the contact's diameter, not radius.
    const contactRadiusM = contact ? contact[2] / 2 : 0
    const distanceLabel =
      shipPosition && contact ? ` — ${formatDistance(Math.hypot(...relativeVector(shipPosition, contact[1])))}` : ""
    const orbitRadius = Math.max(safeOrbitRadiusM(contactRadiusM, 0, autopilot.getMeasuredAccel()), ARRIVAL_RADIUS_M)
    commandPalette.openList(`Nave ${entityId.slice(0, 8)}${distanceLabel}`, [
      {
        label: "Orbit",
        node: {
          kind: "run",
          run: () => {
            if (!contact) return
            // Same snapshot-center limitation as a body orbit (see showBodyMenu): the chase point
            // circles where the contact was at engage time, not a live-tracked position, since a
            // moving ship has no stable "center" to keep re-deriving from a single scan.
            engageAutopilot({
              kind: "orbit",
              center: contact[1],
              radiusM: orbitRadius,
              arrivalRadius: ARRIVAL_RADIUS_M,
              startedAtMs: Date.now(),
              label: `Orbit ${entityId.slice(0, 8)}`,
            })
          },
        },
      },
      {
        label: "Approach",
        node: {
          kind: "edit",
          value: String(DEFAULT_CRUISE_SPEED_MPS),
          commit: (value) =>
            engageAutopilot({
              kind: "shipApproach",
              entityId,
              arrivalRadius: ARRIVAL_RADIUS_M,
              targetRadiusM: contactRadiusM,
              label: `Approach ${entityId.slice(0, 8)}`,
              maxCruiseSpeedMps: parseCruiseSpeed(value),
            }),
        },
      },
      {
        // Tuning + pointing only — aims the nose at the target and holds once settled, without
        // ever engaging the main engine.
        label: "Point",
        node: {
          kind: "run",
          run: () =>
            engageAutopilot({
              kind: "shipApproach",
              entityId,
              arrivalRadius: ARRIVAL_RADIUS_M,
              targetRadiusM: contactRadiusM,
              label: `Point ${entityId.slice(0, 8)}`,
              pointOnly: true,
            }),
        },
      },
      {
        label: "Target",
        node: { kind: "run", run: () => turretModule && void ionClient.set(turretModule.module_id, "target", entityId) },
      },
    ])
  }

  function showBodyMenu(entryIndex: number, kind: string, position: FloatingOriginPosition | null): void {
    if (!position) return
    // SystemMapEntry's diameter_m is a diameter, not a radius.
    const bodyRadiusM = (systemMapPoller.getLatest()[entryIndex]?.diameter_m ?? 0) / 2
    const massKg = systemMapPoller.getLatest()[entryIndex]?.mass_kg ?? 0
    const orbitRadius = Math.max(safeOrbitRadiusM(bodyRadiusM, massKg, autopilot.getMeasuredAccel()), ARRIVAL_RADIUS_M)
    const shipPosition = readFloatingPosition(shipStatePoller.getLatest() ?? {})
    const distanceLabel = shipPosition ? ` — ${formatDistance(Math.hypot(...relativeVector(shipPosition, position)))}` : ""
    commandPalette.openList(`${kind}${distanceLabel}`, [
      {
        label: "Orbit",
        node: {
          kind: "run",
          run: () =>
            // The orbit chase point already sits `orbitRadius` out from the body's center, so the
            // autopilot should treat it as a bare point (radius 0), not double-count the body's own radius.
            engageAutopilot({
              kind: "orbit",
              center: position,
              radiusM: orbitRadius,
              arrivalRadius: ARRIVAL_RADIUS_M,
              startedAtMs: Date.now(),
              label: `Orbit ${kind}`,
            }),
        },
      },
      {
        label: "Approach",
        node: {
          kind: "edit",
          value: String(DEFAULT_CRUISE_SPEED_MPS),
          commit: (value) =>
            engageAutopilot({
              kind: "bodyApproach",
              entryIndex,
              arrivalRadius: ARRIVAL_RADIUS_M,
              targetRadiusM: bodyRadiusM,
              label: `Approach ${kind}`,
              maxCruiseSpeedMps: parseCruiseSpeed(value),
            }),
        },
      },
      {
        // Tuning + pointing only — aims the nose at the target and holds once settled, without
        // ever engaging the main engine.
        label: "Point",
        node: {
          kind: "run",
          run: () =>
            engageAutopilot({
              kind: "bodyApproach",
              entryIndex,
              arrivalRadius: ARRIVAL_RADIUS_M,
              targetRadiusM: bodyRadiusM,
              label: `Point ${kind}`,
              pointOnly: true,
            }),
        },
      },
    ])
  }

  /** "Naviga" group: every known point (system-map bodies + scanner contacts), nearest-first. */
  function buildNavigationItems(): PaletteItem[] {
    const shipPosition = readFloatingPosition(shipStatePoller.getLatest() ?? {})
    if (!shipPosition) return []

    const bodies = systemMapPoller
      .getLatest()
      .map((entry, entryIndex) => ({ entry, entryIndex }))
      .filter(({ entry }) => entry.kind === "star" || entry.kind === "planet")
      .map(({ entry, entryIndex }) => {
        const distanceM = Math.hypot(...relativeVector(shipPosition, entry.position))
        const icon = entry.kind === "star" ? "☉" : "●"
        const label = entry.kind === "star" ? "stella" : "pianeta"
        return {
          distanceM,
          label: `${icon} ${label} — ${formatDistance(distanceM)}`,
          onOpen: () => showBodyMenu(entryIndex, entry.kind, entry.position),
        }
      })

    const ships = radarPoller.getLatest().map(([entityId, position]) => {
      const distanceM = Math.hypot(...relativeVector(shipPosition, position))
      return {
        distanceM,
        label: `▲ ${entityId.slice(0, 8)} — ${formatDistance(distanceM)}`,
        onOpen: () => showShipMenu(entityId),
      }
    })

    return [...bodies, ...ships]
      .sort((a, b) => a.distanceM - b.distanceM)
      .map(({ label, onOpen }) => ({ label, node: { kind: "run", run: onOpen } }) as PaletteItem)
  }

  function formatVariableValue(value: unknown): string {
    if (value === null || value === undefined) return "-"
    if (typeof value === "object") return JSON.stringify(value)
    return String(value)
  }

  /** A module's MAN manifest as palette items: mutable variables (edit), read-only variables (info), actions (run/edit-params). */
  /** A "component_ref" variable (e.g. a thruster's `fuelcell`) points at another module id — offer the ship's modules of the type its `constraints.component_type` names, instead of a free-text id field. */
  function referencePickerNode(moduleId: string, variableName: string, componentType: unknown): PaletteNode {
    return {
      kind: "picker",
      load: () =>
        currentModules
          .filter((m) => m.type === componentType)
          .map((m) => ({
            label: `${m.type} ${m.module_id.slice(0, 8)}`,
            node: { kind: "run", run: () => void ionClient.set(moduleId, variableName, m.module_id) },
          })),
    }
  }

  async function moduleFunctionItems(moduleId: string): Promise<PaletteItem[]> {
    const manifest = await ionClient.man(moduleId)
    const variableItems: PaletteItem[] = manifest.variables.map((v) => {
      if (!v.mutable) return { label: `${v.name}: ${formatVariableValue(v.value)}`, node: { kind: "info" } }
      const label = `${v.name} — ${formatVariableValue(v.value)}`
      if (v.type === "component_ref") {
        return { label, node: referencePickerNode(moduleId, v.name, (v.constraints as { component_type?: unknown } | null)?.component_type) }
      }
      return { label, node: { kind: "edit", value: formatVariableValue(v.value), commit: (value) => ionClient.set(moduleId, v.name, value) } }
    })
    const actionItems: PaletteItem[] = manifest.actions.map((a) =>
      a.params.length === 0
        ? { label: a.name, node: { kind: "run", run: () => void ionClient.action(moduleId, a.name) } }
        : {
            label: `${a.name} (${a.params.map((p) => p.name).join(", ")})`,
            node: {
              kind: "edit",
              value: "",
              commit: (value) => void ionClient.action(moduleId, a.name, ...value.trim().split(/\s+/).filter(Boolean)),
            },
          },
    )
    return [...variableItems, ...actionItems]
  }

  /** One command-palette group per module type present on the ship (grouped by ModulesModal's tabs where one applies, else by the raw type — e.g. Radar/SystemMap, which aren't in any modal tab). `extraItems` are prepended (e.g. the autopilot stop command under "Spostamento"). */
  function moduleGroupItem(label: string, modules: ModuleRef[], extraItems: PaletteItem[] = []): PaletteItem {
    return {
      label,
      node: {
        kind: "list",
        load: async () => {
          // A single component skips straight to its functions — no point making the player
          // pick "the one Radar" before picking "scan".
          if (modules.length === 1 && extraItems.length === 0) return moduleFunctionItems(modules[0].module_id)
          const moduleItems: PaletteItem[] = modules.map((m) => ({
            label: `${m.type} ${m.module_id.slice(0, 8)}`,
            node: { kind: "list", load: () => moduleFunctionItems(m.module_id) },
          }))
          return [...extraItems, ...moduleItems]
        },
      },
    }
  }

  function buildCommandPaletteRoot(): PaletteItem[] {
    const groups = new Map<string, ModuleRef[]>()
    for (const m of currentModules) {
      const tab = tabForModuleType(m.type)
      const key = tab ? TAB_LABELS[tab] : m.type
      const list = groups.get(key) ?? []
      list.push(m)
      groups.set(key, list)
    }

    const propulsionLabel = TAB_LABELS.propulsion
    const disengageNode: PaletteNode = autopilot.engaged ? { kind: "run", run: disengageAutopilot } : { kind: "info" }
    const propulsionExtra: PaletteItem[] = [
      { label: autopilot.engaged ? "Ferma autopilota" : "Nessuna manovra attiva", node: disengageNode },
      { label: "Full stop", node: { kind: "run", run: () => engageAutopilot({ kind: "stop" }) } },
    ]
    if (!groups.has(propulsionLabel)) groups.set(propulsionLabel, [])

    const moduleGroups = Array.from(groups.entries()).map(([label, modules]) =>
      moduleGroupItem(label, modules, label === propulsionLabel ? propulsionExtra : []),
    )

    return [{ label: "Naviga", node: { kind: "list", load: buildNavigationItems } }, ...moduleGroups]
  }

  systemMapPoller.start()
  radarPoller.start()
  scene.setOwnShipVisible(tactical)

  shipStatePoller.subscribe((entity) => {
    hud.update(entity)
    if (!tactical) {
      scene.setCockpitPosition(readPosition(entity))
      scene.setOrientation(readOrientation(entity))
    } else {
      tacticalCamera?.setShipPosition(readPosition(entity))
      const velocity = readVelocity(entity)
      if (velocity) tacticalCamera?.setShipSpeed(Math.hypot(velocity.x, velocity.y, velocity.z))
      if (tacticalCamera) {
        const shipPosition = readFloatingPosition(entity)
        const target = activeGoal && activeGoal.kind !== "stop" ? resolveGoal(activeGoal).getTarget(Date.now()) : null
        tacticalCamera.setAimPoint(
          shipPosition && target
            ? new THREE.Vector3(...readPosition(entity)).add(new THREE.Vector3(...relativeVector(shipPosition, target)))
            : null,
        )
      }
      scene.setOwnShipTransform(readPosition(entity), readOrientation(entity))
      const size = readShipSize(entity)
      if (size !== null) scene.setOwnShipSize(size)
    }
    const modules = readModules(entity)
    currentModules = modules
    modal.setModules(modules)
    propulsion.setModules(modules, entity)
    propulsion.syncFromEntity(entity)
    autopilot.setModules(modules, entity)

    if (pendingResume) {
      const goal = pendingResume
      // "stop" needs no live position; other kinds wait for their poller's first data so
      // resolveGoal's getTarget doesn't see null and immediately auto-disengage (autopilot.tick()
      // treats a null target as "target lost").
      if (goal.kind === "stop" || resolveGoal(goal).getTarget(Date.now()) !== null) {
        pendingResume = null
        engageAutopilot(goal)
        // Fast-forwards back to whatever phase (burning/reverse/stopping/…) the autopilot was in
        // before the refresh, instead of restarting the maneuver from tuning/pointing — see
        // autopilotPhase.ts.
        autopilot.resumePhase(loadAutopilotPhase())
      }
    }

    void autopilot.tick(entity)
    autopilotStatus.update(autopilot.engaged, autopilot.statusLabel, autopilot.statusPhase)
    // Covers auto-disengage inside autopilot.tick() (full-stop reaching zero speed, target lost,
    // calibration failure) — those don't go through disengageAutopilot()/engageAutopilot() above.
    if (!autopilot.engaged) {
      saveAutopilotGoal(null)
      activeGoal = null
    }

    orientationPanel.update(readOrientation(entity), readEngineActivations(entity, modules), readFuelLevels(entity, modules))

    const systemMapModule = modules.find((m) => SYSTEM_MAP_TYPES.has(m.type))
    systemMapPoller.setModuleId(systemMapModule?.module_id ?? null)

    const radarModule = modules.find((m) => RADAR_TYPES.has(m.type))
    radarPoller.setModuleId(radarModule?.module_id ?? null)

    const shipPosition = readFloatingPosition(entity)
    if (shipPosition) {
      const entries = systemMapPoller.getLatest()
      const contacts = radarPoller.getLatest()
      starfield.update(readPosition(entity), shipPosition, entries)
      minimap.update(shipPosition, readOrientation(entity), entries, contacts)
      systemPanel.update(shipPosition, entries)
      radarPanel.update(shipPosition, contacts)

      // Radar contacts always render at real scale/position (10km, radar.rs's
      // RADAR_SCAN_DISTANCE — always well within starfield.ts's NEAR_RENDER_THRESHOLD_M).
      // SystemMap entries get the same treatment conditionally, inside starfield.update() itself,
      // since most of them (other systems' stars, light-years away) can't render to true scale.
      // Computed once and reused for the on-screen direction markers below, so a contact's label
      // lines up exactly with its rendered position instead of being derived independently.
      const contactPositions = contacts.map(([entityId, position, size]) => {
        const [dx, dy, dz] = relativeVector(shipPosition, position)
        const distanceM = Math.hypot(dx, dy, dz)
        const worldPosition = new THREE.Vector3(
          shipPosition.shift.x + dx,
          shipPosition.shift.y + dy,
          shipPosition.shift.z + dz,
        )
        return { entityId, size, worldPosition, distanceM }
      })
      scene.syncContacts(
        contactPositions.map(({ entityId, size, worldPosition }) => ({
          entityId,
          size,
          position: [worldPosition.x, worldPosition.y, worldPosition.z] as [number, number, number],
        })),
      )

      directionMarkers.update(scene.camera, [
        ...starfield.getPickables().map((p) => ({ icon: p.kind === "star" ? "☉" : "●", worldPosition: p.position, distanceM: p.distanceM })),
        ...contactPositions.map((c) => ({ icon: "▲", worldPosition: c.worldPosition, distanceM: c.distanceM })),
      ])
    }
  })
  shipStatePoller.start()

  window.setInterval(() => void propulsion.tick(), PROPULSION_TICK_MS)

  let lastRenderAt = 0
  function animate(now: number): void {
    requestAnimationFrame(animate)
    if (now - lastRenderAt < RENDER_INTERVAL_MS) return
    const dtSeconds = lastRenderAt === 0 ? 0 : (now - lastRenderAt) / 1000
    lastRenderAt = now
    tacticalCamera?.update(dtSeconds)
    scene.render()
    fpsCounter.tick()
  }
  requestAnimationFrame(animate)
}

if (ionClient.isLoggedIn) {
  startGame()
} else {
  renderLogin(app, startGame)
}
