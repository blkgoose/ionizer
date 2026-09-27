import "./style.css"
import { ionClient } from "./api/client"
import { SYSTEM_MAP_TYPES } from "./api/modules"
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
} from "./state/shipState"
import { systemMapPoller } from "./state/systemMap"

const PROPULSION_TICK_MS = 100

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

  shipStatePoller.subscribe((entity) => {
    hud.update(entity)
    scene.setCockpitPosition(readPosition(entity))
    scene.setOrientation(readOrientation(entity))
    const modules = readModules(entity)
    modal.setModules(modules)
    propulsion.setModules(modules, entity)
    propulsion.syncFromEntity(entity)

    orientationPanel.update(readOrientation(entity), readEngineActivations(entity, modules))

    const systemMapModule = modules.find((m) => SYSTEM_MAP_TYPES.has(m.type))
    systemMapPoller.setModuleId(systemMapModule?.module_id ?? null)

    const shipPosition = readFloatingPosition(entity)
    if (shipPosition) {
      const entries = systemMapPoller.getLatest()
      starfield.update(scene.cameraPosition, shipPosition, entries)
      minimap.update(shipPosition, entries)
      systemPanel.update(shipPosition, entries)
      directionMarkers.update(scene.camera, shipPosition, entries)
    }
  })
  shipStatePoller.start()

  window.setInterval(() => void propulsion.tick(), PROPULSION_TICK_MS)

  function animate(): void {
    scene.render()
    fpsCounter.tick()
    requestAnimationFrame(animate)
  }
  animate()
}

if (ionClient.isLoggedIn) {
  startGame()
} else {
  renderLogin(app, startGame)
}
