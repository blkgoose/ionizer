import type { ModuleManifest, ShipEntity } from "./types"
import { IonCommandError } from "./types"

// Same host the client itself was loaded from — "localhost" would resolve to the
// browser's own machine when the client is opened remotely (e.g. http://192.168.1.4:3003).
const SERVER_URL = `http://${window.location.hostname}:3001/api/v1`
const TOKEN_STORAGE_KEY = "ion.token"

async function sendCommand(command: string, token: string | null): Promise<string> {
  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, command }),
  })

  if (!response.ok) {
    throw new IonCommandError(`HTTP ${response.status} for command: ${command}`)
  }

  const raw: string = await response.json()
  if (raw.startsWith("error: ")) {
    throw new IonCommandError(raw.slice("error: ".length))
  }
  return raw
}

export class IonClient {
  private token: string | null = sessionStorage.getItem(TOKEN_STORAGE_KEY)

  get isLoggedIn(): boolean {
    return this.token !== null
  }

  async login(shipId: string, component: string, password: string): Promise<void> {
    const jwt = await sendCommand(`LOGIN ${shipId} ${component} ${password}`, null)
    this.token = jwt
    sessionStorage.setItem(TOKEN_STORAGE_KEY, jwt)
  }

  logout(): void {
    this.token = null
    sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  }

  async get(): Promise<ShipEntity> {
    const json = await sendCommand("GET", this.token)
    return JSON.parse(json)
  }

  async man(moduleId: string): Promise<ModuleManifest> {
    const json = await sendCommand(`MAN ${moduleId}`, this.token)
    return JSON.parse(json)
  }

  async set(moduleId: string, variable: string, value: string | number | boolean): Promise<void> {
    await sendCommand(`SET ${moduleId} ${variable} ${value}`, this.token)
  }

  async action(moduleId: string, actionName: string, ...params: string[]): Promise<string> {
    return sendCommand(`ACTION ${moduleId} ${actionName} ${params.join(" ")}`.trim(), this.token)
  }

  /** For actions whose result is JSON (e.g. SystemMap.scan, Radar.scan) rather than "done". */
  async actionJson<T>(moduleId: string, actionName: string, ...params: string[]): Promise<T> {
    const raw = await this.action(moduleId, actionName, ...params)
    return JSON.parse(raw)
  }
}

export const ionClient = new IonClient()
