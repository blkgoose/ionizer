import "./style.css"
import { ionClient } from "./api/client"
import { RADAR_TYPES, SYSTEM_MAP_TYPES } from "./api/modules"
import { renderLogin } from "./ui/login"
import { Hud } from "./ui/hud"
import { ModulesModal } from "./ui/modulesModal"
import { Minimap } from "./ui/minimap"
import { SystemPanel } from "./ui/systemPanel"
import { OrientationPanel } from "./ui/orientationPanel"
import { DirectionMarkers } from "./ui/directionMarkers"
import { FpsCounter } from "./ui/fpsCounter"
import { FlightScene } from "./scene/scene"
import { Starfield } from "./scene/starfield"
import { IntelligentPropulsion } from "./scene/propulsion"
import {
  shipStatePoller,
  readPosition,
  readFloatingPosition,
  readModules,
  readOrientation,
  readEngineActivations,
  readFuelLevels,
  relativeVector,
} from "./state/shipState"
import { systemMapPoller } from "./state/systemMap"
import { radarPoller } from "./state/radar"

const PROPULSION_TICK_MS = 100
const RENDER_INTERVAL_MS = 1000 / 15

const app = document.querySelector<HTMLDivElement>("#app")!

function startGame(): void {
  app.innerHTML = ""

  const scene = new FlightScene(app)
  const starfield = new Starfield(scene.scene)
  const hud = new Hud(app, () => {
    ionClient.logout()
    location.reload()
  })
  const modal = new ModulesModal(app)
  const minimap = new Minimap(app)
  const systemPanel = new SystemPanel(app)
  const orientationPanel = new OrientationPanel(app)
  const directionMarkers = new DirectionMarkers(app)
  const fpsCounter = new FpsCounter(app)
  const propulsion = new IntelligentPropulsion()

  systemMapPoller.start()
  radarPoller.start()

  shipStatePoller.subscribe((entity) => {
    hud.update(entity)
    scene.setCockpitPosition(readPosition(entity))
    scene.setOrientation(readOrientation(entity))
    const modules = readModules(entity)
    modal.setModules(modules)
    propulsion.setModules(modules, entity)
    propulsion.syncFromEntity(entity)

    orientationPanel.update(readOrientation(entity), readEngineActivations(entity, modules), readFuelLevels(entity, modules))

    const systemMapModule = modules.find((m) => SYSTEM_MAP_TYPES.has(m.type))
    systemMapPoller.setModuleId(systemMapModule?.module_id ?? null)

    const radarModule = modules.find((m) => RADAR_TYPES.has(m.type))
    radarPoller.setModuleId(radarModule?.module_id ?? null)

    const shipPosition = readFloatingPosition(entity)
    if (shipPosition) {
      const entries = systemMapPoller.getLatest()
      const contacts = radarPoller.getLatest()
      starfield.update(scene.cameraPosition, shipPosition, entries)
      minimap.update(shipPosition, readOrientation(entity), entries, contacts)
      systemPanel.update(shipPosition, entries)
      directionMarkers.update(scene.camera, shipPosition, entries)

      // Radar contacts are close enough (10km, radar.rs's RADAR_SCAN_DISTANCE) to render at real
      // scale/position in the 3D scene too, unlike SystemMap's light-year-away skybox entries.
      scene.syncContacts(
        contacts.map(([entityId, position, size]) => {
          const [dx, dy, dz] = relativeVector(shipPosition, position)
          return {
            entityId,
            size,
            position: [shipPosition.shift.x + dx, shipPosition.shift.y + dy, shipPosition.shift.z + dz] as [
              number,
              number,
              number,
            ],
          }
        }),
      )
    }
  })
  shipStatePoller.start()

  window.setInterval(() => void propulsion.tick(), PROPULSION_TICK_MS)

  let lastRenderAt = 0
  function animate(now: number): void {
    requestAnimationFrame(animate)
    if (now - lastRenderAt < RENDER_INTERVAL_MS) return
    lastRenderAt = now
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
