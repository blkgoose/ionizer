import { ionClient } from "../api/client"

/** Parses a pasted "LOGIN id component pass" (LOGIN keyword optional) into its three fields. */
function parseLoginString(text: string): { shipId: string; component: string; password: string } | null {
  const tokens = text.trim().split(/\s+/)
  if (tokens.length > 0 && tokens[0].toUpperCase() === "LOGIN") {
    tokens.shift()
  }
  if (tokens.length !== 3) return null
  const [shipId, component, password] = tokens
  return { shipId, component, password }
}

export function renderLogin(container: HTMLElement, onSuccess: () => void): void {
  container.innerHTML = `
    <form id="login-form" class="login-form">
      <h1>ionizer</h1>
      <label>Ship ID <input name="shipId" required autocomplete="off" /></label>
      <label>Component <input name="component" required autocomplete="off" value="core" /></label>
      <label>Password <input name="password" type="password" required /></label>
      <button type="submit">Connetti</button>
      <p class="login-error" id="login-error"></p>
    </form>
  `

  const form = container.querySelector<HTMLFormElement>("#login-form")!
  const errorEl = container.querySelector<HTMLParagraphElement>("#login-error")!
  const shipIdInput = form.elements.namedItem("shipId") as HTMLInputElement
  const componentInput = form.elements.namedItem("component") as HTMLInputElement
  const passwordInput = form.elements.namedItem("password") as HTMLInputElement

  const doLogin = async (shipId: string, component: string, password: string) => {
    errorEl.textContent = ""
    try {
      await ionClient.login(shipId, component, password)
      onSuccess()
    } catch (err) {
      errorEl.textContent = err instanceof Error ? err.message : "Login fallito"
    }
  }

  form.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text")
    if (!text) return
    const parsed = parseLoginString(text)
    if (!parsed) return

    event.preventDefault()
    shipIdInput.value = parsed.shipId
    componentInput.value = parsed.component
    passwordInput.value = parsed.password
    void doLogin(parsed.shipId, parsed.component, parsed.password)
  })

  form.addEventListener("submit", (event) => {
    event.preventDefault()
    const data = new FormData(form)
    void doLogin(String(data.get("shipId")), String(data.get("component")), String(data.get("password")))
  })
}
