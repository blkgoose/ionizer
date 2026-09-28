import * as THREE from "three"
import "./style.css"
import { ionClient } from "./api/client"
import { RADAR_TYPES, SYSTEM_MAP_TYPES } from "./api/modules"
import { renderLogin } from "./ui/login"
import { Hud } from "./ui/hud"
import { ModulesModal } from "./ui/modulesModal"
import { Minimap } from "./ui/minimap"
import { SystemPanel, formatDistance } from "./ui/systemPanel"
import { RadarPanel } from "./ui/radarPanel"
import { OrientationPanel } from "./ui/orientationPanel"
import { DirectionMarkers } from "./ui/directionMarkers"
import { FpsCounter } from "./ui/fpsCounter"
import { ContextMenu } from "./ui/contextMenu"
import { AutopilotStatus } from "./ui/autopilotStatus"
import { FlightScene } from "./scene/scene"
import { Starfield } from "./scene/starfield"
import { IntelligentPropulsion } from "./scene/propulsion"
import { TacticalCameraController } from "./scene/tacticalCamera"
import { autopilot, orbitTargetPosition } from "./scene/autopilot"
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
  relativeVector,
  type ModuleRef,
} from "./state/shipState"
import { systemMapPoller } from "./state/systemMap"
import { radarPoller } from "./state/radar"
import type { FloatingOriginPosition } from "./api/types"

const PROPULSION_TICK_MS = 100
const RENDER_INTERVAL_MS = 1000 / 15
const ARRIVAL_RADIUS_M = 200

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
    () => {
      propulsion.enabled = false
      autopilot.setModules(currentModules, shipStatePoller.getLatest())
      autopilot.engageStop()
    },
  )
  const modal = new ModulesModal(app)
  const minimap = new Minimap(app)
  const systemPanel = new SystemPanel(app, (entryIndex, kind, clientX, clientY) => {
    const position = systemMapPoller.getLatest()[entryIndex]?.position ?? null
    showBodyMenu(clientX, clientY, entryIndex, kind, position)
  })
  const radarPanel = new RadarPanel(app)
  const orientationPanel = new OrientationPanel(app)
  const directionMarkers = new DirectionMarkers(app)
  const fpsCounter = new FpsCounter(app)
  const propulsion = new IntelligentPropulsion()
  const contextMenu = new ContextMenu(app)

  // Tactical mode flies exclusively via the autopilot (mouse targeting + context menu), so
  // manual keyboard thruster control stands down entirely — WASD/arrows are the camera's pan
  // input there instead (see TacticalCameraController).
  propulsion.enabled = !tactical
  const tacticalCamera = tactical ? new TacticalCameraController(scene.camera, scene.renderer.domElement) : null

  let currentModules: ModuleRef[] = []

  function disengageAutopilot(): void {
    autopilot.disengage()
    propulsion.enabled = !tactical
  }

  const autopilotStatus = new AutopilotStatus(app, disengageAutopilot)

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && autopilot.engaged) disengageAutopilot()
  })

  if (tacticalCamera) {
    const raycaster = new THREE.Raycaster()
    // Bright wireframe sphere sized to whatever was actually hit (the invisible, deliberately
    // oversized hit-target — see scene.ts/starfield.ts) so hovering shows exactly where a click
    // will register, since stars/planets are tiny, hard-to-hit skybox dots otherwise.
    const hoverHighlight = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xffee66, wireframe: true, transparent: true, opacity: 0.7 }),
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
      // Without this, the click bubbles up to ContextMenu's own window-level "click" listener
      // (which exists to dismiss an already-open menu on an outside click) and immediately
      // hides the menu this very click is about to open.
      event.stopPropagation()

      const hovered = findHovered(event.clientX, event.clientY)
      if (!hovered) {
        contextMenu.hide()
        return
      }
      if (hovered.kind === "ship") {
        showShipMenu(event.clientX, event.clientY, hovered.entityId)
      } else {
        const position = systemMapPoller.getLatest()[hovered.entryIndex]?.position ?? null
        showBodyMenu(event.clientX, event.clientY, hovered.entryIndex, hovered.bodyKind, position)
      }
    })

    scene.renderer.domElement.addEventListener("mousemove", (event) => {
      const hovered = findHovered(event.clientX, event.clientY)
      if (hovered) {
        const sphere = new THREE.Box3().setFromObject(hovered.object).getBoundingSphere(new THREE.Sphere())
        hoverHighlight.position.copy(sphere.center)
        hoverHighlight.scale.setScalar(sphere.radius)
        hoverHighlight.visible = true
        scene.renderer.domElement.style.cursor = "pointer"
      } else {
        hoverHighlight.visible = false
        scene.renderer.domElement.style.cursor = "default"
      }
    })
  }

  function engageAutopilot(
    getTarget: (nowMs: number) => FloatingOriginPosition | null,
    arrivalRadius: number,
    targetRadiusM: number,
    label: string,
  ): void {
    propulsion.enabled = false
    autopilot.setModules(currentModules, shipStatePoller.getLatest())
    autopilot.engage(getTarget, arrivalRadius, targetRadiusM, label)
  }

  function showShipMenu(x: number, y: number, entityId: string): void {
    const turretModule = currentModules.find((m) => m.type === "Turret")
    const shipPosition = readFloatingPosition(shipStatePoller.getLatest() ?? {})
    const contact = radarPoller.getLatest().find(([id]) => id === entityId)
    // radar.rs's Radar.scan reports `size` as the contact's diameter, not radius.
    const contactRadiusM = contact ? contact[2] / 2 : 0
    const distanceLabel =
      shipPosition && contact ? ` — ${formatDistance(Math.hypot(...relativeVector(shipPosition, contact[1])))}` : ""
    contextMenu.show(x, y, `Nave ${entityId.slice(0, 8)}${distanceLabel}`, [
      {
        label: "Target",
        onSelect: () => {
          if (turretModule) void ionClient.set(turretModule.module_id, "target", entityId)
        },
      },
      {
        label: "Approach",
        onSelect: () => {
          engageAutopilot(
            () => radarPoller.getLatest().find(([id]) => id === entityId)?.[1] ?? null,
            ARRIVAL_RADIUS_M,
            contactRadiusM,
            `Approach ${entityId.slice(0, 8)}`,
          )
        },
      },
    ])
  }

  function showBodyMenu(x: number, y: number, entryIndex: number, kind: string, position: FloatingOriginPosition | null): void {
    if (!position) return
    // SystemMapEntry's diameter_m is a diameter, not a radius.
    const bodyRadiusM = (systemMapPoller.getLatest()[entryIndex]?.diameter_m ?? 0) / 2
    const orbitRadius = Math.max(bodyRadiusM + 200, ARRIVAL_RADIUS_M)
    const shipPosition = readFloatingPosition(shipStatePoller.getLatest() ?? {})
    const distanceLabel = shipPosition ? ` — ${formatDistance(Math.hypot(...relativeVector(shipPosition, position)))}` : ""
    contextMenu.show(x, y, `${kind}${distanceLabel}`, [
      {
        label: "Orbit",
        onSelect: () => {
          // The orbit chase point already sits `orbitRadius` out from the body's center, so the
          // autopilot should treat it as a bare point (radius 0), not double-count the body's own radius.
          engageAutopilot(orbitTargetPosition(position, orbitRadius, Date.now()), ARRIVAL_RADIUS_M, 0, `Orbit ${kind}`)
        },
      },
      {
        label: "Approach",
        onSelect: () => {
          engageAutopilot(
            () => systemMapPoller.getLatest()[entryIndex]?.position ?? null,
            ARRIVAL_RADIUS_M,
            bodyRadiusM,
            `Approach ${kind}`,
          )
        },
      },
    ])
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
    void autopilot.tick(entity)
    autopilotStatus.update(autopilot.engaged, autopilot.statusLabel, autopilot.statusPhase)

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

      // Radar contacts are close enough (10km, radar.rs's RADAR_SCAN_DISTANCE) to render at real
      // scale/position in the 3D scene too, unlike SystemMap's light-year-away skybox entries.
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
