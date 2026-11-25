// Logica di automazione di UNA traccia, con Playwright, usando il tuo profilo loggato.
// PRINCIPIO: esegue le azioni REALI (follow/like/repost autentici) e NON falsifica
// lo stato "done" del gate. Automatizza solo i passaggi meccanici (email, download)
// e la sequenza.
import path from "path"
import fs from "fs"
import crypto from "crypto"
import { spawn } from "child_process"
import { fileURLToPath } from "url"
import { chromium } from "playwright"
import { CONFIG } from "./config.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const profileDir = process.env.HSH_PROFILE_DIR || path.join(__dirname, "user-profile")

let ctx // contesto browser persistente, riusato tra le tracce
let aborted = false // impostato da requestStop(): interrompe la traccia in corso
let loginChild = null // browser "normale" aperto per il login (senza automazione)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function requestStop() {
  aborted = true
}
export function resetStop() {
  aborted = false
}

export const profileExists = () => fs.existsSync(profileDir)
export const browserOpen = () => !!ctx
export const loginWindowOpen = () => !!loginChild

// ---------- scelta del browser ----------
const EXES =
  process.platform === "win32"
    ? {
        chrome: [
          `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        ],
        msedge: [
          `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ],
      }
    : {
        chrome: ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"],
        msedge: ["/usr/bin/microsoft-edge", "/opt/microsoft/msedge/msedge"],
      }

// Login remoto (Docker/Linux senza schermo): Chrome normale dentro uno schermo virtuale
// (Xvfb) che apri dal tuo PC nel browser tramite noVNC. Vedi DOCKER.md.
const REMOTE_LOGIN = process.env.HSH_REMOTE_LOGIN === "1"
const NOVNC_PORT = Number(process.env.HSH_NOVNC_PORT) || 6080

// Se il container viene ricreato, Chrome vede un lock del profilo con un altro hostname e
// rifiuta di aprirlo. Quando nessun nostro browser e' aperto, i lock sono residui: li tolgo.
function cleanStaleProfileLocks() {
  if (process.platform === "win32") return
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      fs.rmSync(path.join(profileDir, f), { force: true })
    } catch {}
  }
}
const findExe = (channel) => (EXES[channel] || []).find((p) => p && fs.existsSync(p)) || null

// "auto": Chrome se c'e', altrimenti Edge, altrimenti Chromium di Playwright.
export function resolveChannel() {
  const want = CONFIG.browserChannel
  if (want === "chromium") return "chromium"
  const order = want === "auto" ? ["chrome", "msedge"] : [want, "chrome", "msedge"]
  return order.find((c) => findExe(c)) || "chromium"
}

export const CHANNEL_LABEL = { chrome: "Google Chrome", msedge: "Microsoft Edge", chromium: "Chromium (Playwright)" }

// ---------- browser per la coda ----------
let launching // evita due avvii simultanei (stesso profilo)
export function ensureBrowser(log) {
  if (ctx) return Promise.resolve(ctx)
  if (loginChild) {
    return Promise.reject(new Error("La finestra di login e' ancora aperta: chiudila e riprova."))
  }
  if (!launching) {
    // headless: nessuna finestra e nessuna interazione (si puo' mostrare solo per diagnostica)
    launching = launchContext({ headless: !CONFIG.showBrowser }, log).then((c) => {
      ctx = c
      // se chiudi la finestra a mano, alla traccia successiva lo riapriamo
      c.on("close", () => {
        if (ctx === c) ctx = undefined
      })
      log && log(`Browser avviato (${CHANNEL_LABEL[resolveChannel()]})`)
      return c
    }).finally(() => {
      launching = undefined
    })
  }
  return launching
}

async function launchContext({ headless }, log) {
  fs.mkdirSync(profileDir, { recursive: true })
  if (!loginChild) cleanStaleProfileLocks()
  fs.mkdirSync(path.resolve(__dirname, CONFIG.downloadDir), { recursive: true })
  const channel = resolveChannel()
  const opts = {
    headless,
    acceptDownloads: true,
    // gli step sono stati collaudati con le pagine in italiano: lo fisso anche in un container
    locale: process.env.HSH_LOCALE || "it-IT",
    ...(headless ? { viewport: { width: 1280, height: 900 } } : { viewport: null, args: ["--start-maximized"] }),
  }
  if (channel !== "chromium") opts.channel = channel
  // In Docker /dev/shm e' piccola (64 MB) e Chrome crasha: uso /tmp, cosi' non serve shm_size nel compose
  // (CasaOS/ZimaOS non lo gestisce).
  if (process.env.HSH_DOCKER === "1") opts.args = [...(opts.args || []), "--disable-dev-shm-usage"]
  try {
    return await chromium.launchPersistentContext(profileDir, opts)
  } catch (e) {
    if (/user data directory|already in use|ProcessSingleton|Target page, context or browser has been closed/i.test(e.message)) {
      throw new Error("Il profilo e' in uso da un'altra finestra: chiudi il browser di login e riprova.")
    }
    throw e
  }
}

export async function closeBrowser() {
  if (ctx) await ctx.close().catch(() => {})
  ctx = undefined
}

// ---------- login con un browser NORMALE (nessuna automazione) ----------
// Google (e altri) rifiutano l'accesso da browser pilotati. Per il login apriamo quindi
// Chrome/Edge in modo normale, con lo stesso profilo usato poi dall'automazione.
export const LOGIN_URLS = {
  soundcloud: "https://soundcloud.com/signin",
  spotify: "https://accounts.spotify.com/login",
  instagram: "https://www.instagram.com/accounts/login/",
}

// --- schermo remoto (solo con HSH_REMOTE_LOGIN=1): Xvfb + x11vnc + noVNC ---
// noVNC non viene esposto con una porta propria: server.js lo ripropone sotto /novnc sulla
// STESSA porta dell'app, quindi funziona con qualunque porta host scelta nel compose.
let remoteProcs = []
let remotePw = "" // password VNC di questa sessione: casuale, salvo HSH_VNC_PASSWORD
let remotePwAuto = false
const vncPassFile = "/tmp/hsh-vncpass"
export const remoteLoginActive = () => REMOTE_LOGIN && remoteProcs.length > 0
export const novncPort = () => NOVNC_PORT

function remoteInfo() {
  const q = "autoconnect=true&resize=scale&path=novnc/websockify" + (remotePwAuto ? "&password=" + encodeURIComponent(remotePw) : "")
  return { remote: { path: "/novnc/vnc.html?" + q, passwordAuto: remotePwAuto } }
}

async function startRemoteDesktop(log) {
  remotePwAuto = !process.env.HSH_VNC_PASSWORD
  remotePw = process.env.HSH_VNC_PASSWORD || crypto.randomBytes(9).toString("base64url").slice(0, 8)
  const display = ":99"
  const env = { ...process.env, DISPLAY: display }
  const run = (cmd, args, name) => {
    const p = spawn(cmd, args, { env, stdio: "ignore" })
    p.on("error", (e) => log(`Login remoto: ${name} non parte (${e.message})`))
    remoteProcs.push(p)
    return p
  }
  run("Xvfb", [display, "-screen", "0", "1366x850x24", "-nolisten", "tcp"], "Xvfb")
  for (let i = 0; i < 50 && !fs.existsSync("/tmp/.X11-unix/X99"); i++) await sleep(100)
  run("fluxbox", [], "fluxbox") // gestore finestre minimo (focus e ridimensionamento)
  // password VNC (il protocollo ne usa solo i primi 8 caratteri), salvata in un file privato
  await new Promise((res) => spawn("x11vnc", ["-storepasswd", remotePw, vncPassFile], { stdio: "ignore" }).on("exit", res).on("error", res))
  try { fs.chmodSync(vncPassFile, 0o600) } catch {}
  // x11vnc ascolta solo dentro il container; websockify solo su localhost (lo ripropone server.js)
  run("x11vnc", ["-display", display, "-rfbport", "5900", "-localhost", "-forever", "-shared", "-noxdamage", "-rfbauth", vncPassFile], "x11vnc")
  run("websockify", ["--web", "/usr/share/novnc", String(NOVNC_PORT), "localhost:5900"], "noVNC")
  await sleep(1200)
  return env
}

function stopRemoteDesktop() {
  for (const p of remoteProcs) {
    try { p.kill("SIGTERM") } catch {}
  }
  remoteProcs = []
  remotePw = ""
  try { fs.rmSync(vncPassFile, { force: true }) } catch {}
}

let loginStarting = false
let loginSite = null // sito per cui la finestra di login e' aperta
let loginOnClosed = null
export const loginSiteOpen = () => loginSite

// argomenti di un browser NORMALE: nessun flag di automazione (Google lo rifiuterebbe altrimenti)
function loginArgs(url) {
  const a = [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"]
  if (REMOTE_LOGIN) {
    a.push("--lang=" + (process.env.HSH_LOCALE || "it-IT"), "--no-sandbox", "--password-store=basic", "--disable-dev-shm-usage", "--window-position=0,0", "--window-size=1366,850")
  }
  a.push(url)
  return a
}

// Apre il login. Se una finestra e' gia' aperta NON da' errore: la "riapre" (schermo remoto di
// nuovo disponibile, oppure una nuova scheda/finestra sul sito richiesto).
// Ritorna { remote?: { path }, reopened?: true }.
export async function openLoginWindow(site, log, onClosed) {
  const url = LOGIN_URLS[site]
  if (!url) throw new Error("Account sconosciuto")
  const channel = resolveChannel()
  const exe = findExe(channel)
  if (!exe) {
    throw new Error(
      "Per accedere (soprattutto con Google) serve Google Chrome o Microsoft Edge installato: non li trovo."
    )
  }
  if (loginStarting) throw new Error("Il login si sta aprendo: riprova tra un attimo.")
  if (loginChild) {
    // stesso profilo: il browser gia' aperto riceve l'indirizzo e mostra una nuova scheda
    const env = REMOTE_LOGIN ? { ...process.env, DISPLAY: ":99" } : process.env
    spawn(exe, loginArgs(url), { detached: !REMOTE_LOGIN, stdio: "ignore", env }).on("error", () => {}).unref()
    loginSite = site
    onClosed && (loginOnClosed = onClosed)
    log(`Login gia' aperto: lo riapro su ${site}`)
    return REMOTE_LOGIN ? { ...remoteInfo(), reopened: true } : { reopened: true }
  }
  loginStarting = true
  try {
    await closeBrowser() // libera il profilo
    fs.mkdirSync(profileDir, { recursive: true })
    cleanStaleProfileLocks()
    const env = REMOTE_LOGIN ? await startRemoteDesktop(log) : process.env
    const child = spawn(exe, loginArgs(url), { detached: !REMOTE_LOGIN, stdio: "ignore", env })
    loginChild = child
    loginSite = site
    loginOnClosed = onClosed || null
    const finished = (msg) => {
      if (loginChild !== child) return
      loginChild = null
      loginSite = null
      stopRemoteDesktop()
      log(msg)
      const cb = loginOnClosed
      loginOnClosed = null
      cb && setTimeout(cb, 1500)
    }
    child.on("error", (e) => finished(`Impossibile aprire ${CHANNEL_LABEL[channel]}: ${e.message}`))
    child.on("exit", () => finished("Finestra di login chiusa"))
    if (!REMOTE_LOGIN) child.unref()
    log(
      REMOTE_LOGIN
        ? `Login remoto pronto (${site}): si apre lo schermo del server nel browser. Accedi, poi chiudi Chrome (o premi «Chiudi login»).`
        : `Aperto ${CHANNEL_LABEL[channel]} per il login (${site}). Accedi, poi chiudi la finestra.`
    )
    return REMOTE_LOGIN ? remoteInfo() : {}
  } catch (e) {
    stopRemoteDesktop()
    throw e
  } finally {
    loginStarting = false
  }
}

// Chiude il login (anche se la finestra e' "rimasta aperta"): termina il browser e lo schermo
// remoto e fa ripartire la verifica degli account. Ritorna false se non c'era nulla da chiudere.
export function closeLoginWindow(log) {
  const c = loginChild
  if (!c && !remoteProcs.length) return false
  if (c) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" })
      else c.kill("SIGTERM")
    } catch {}
  }
  stopRemoteDesktop()
  // se l'evento "exit" non arriva, non resto bloccato
  setTimeout(() => {
    if (c && loginChild === c) {
      loginChild = null
      loginSite = null
      log && log("Finestra di login chiusa")
      const cb = loginOnClosed
      loginOnClosed = null
      cb && cb()
    }
  }, 3000)
  return true
}

// Controlla dai cookie del profilo quali account risultano collegati.
const COOKIE_CHECKS = {
  soundcloud: { domain: "soundcloud.com", names: ["oauth_token"] },
  spotify: { domain: "spotify.com", names: ["sp_dc", "sp_key"] },
  instagram: { domain: "instagram.com", names: ["sessionid"] },
}
// Verifica REALE: apre il sito e controlla che l'account sia davvero loggato (un cookie
// puo' esistere ed essere scaduto). Ritorna true | false | null (null = non so: rete, pagina
// cambiata... in quel caso non si dichiara scaduto l'account).
const LOGIN_PROBES = {
  soundcloud: async (page) => {
    await page.goto("https://soundcloud.com/", { waitUntil: "domcontentloaded", timeout: 30000 })
    await dismissConsent(page)
    return page.locator(".header__userNavUsernameButton").first().waitFor({ timeout: 15000 }).then(() => true, () => false)
  },
  spotify: async (page) => {
    await page.goto("https://accounts.spotify.com/en/status", { waitUntil: "domcontentloaded", timeout: 30000 })
    await sleep(3000)
    if (/login|authorize/i.test(page.url())) return false
    // la pagina "status" dice esplicitamente "Logged in as ..." oppure "You are logged out"
    const t = await page.evaluate(() => document.body.innerText).catch(() => "")
    if (/you are logged out/i.test(t)) return false
    return /logged in as/i.test(t) ? true : null
  },
  instagram: async (page) => {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 })
    await sleep(4500)
    if (/accounts\/login|challenge|suspended|checkpoint/i.test(page.url())) return false
    // da disconnessi la home mostra il pulsante/link "Accedi" / "Log in"
    const loginLink = await page
      .evaluate(() => [...document.querySelectorAll("a,button")].some((e) => /^(log ?in|accedi)$/i.test(e.innerText.trim())))
      .catch(() => null)
    if (loginLink === null) return null
    return !loginLink
  },
}

async function probeLogin(c, site) {
  const page = await c.newPage()
  try {
    return await LOGIN_PROBES[site](page)
  } catch {
    return null
  } finally {
    await page.close().catch(() => {})
  }
}

// Verifica un solo account col browser della coda (se e' aperto) — usata dal worker
export async function verifyAccount(site) {
  if (!LOGIN_PROBES[site]) return null
  const c = await ensureBrowser()
  return probeLogin(c, site)
}

export async function checkAccounts({ deep = true } = {}) {
  if (loginChild) throw new Error("Chiudi la finestra di login, poi verifica.")
  if (!profileExists()) return { soundcloud: false, spotify: false, instagram: false }
  let tmp
  let c = ctx
  if (!c) {
    if (launching) c = await launching
    else c = tmp = await launchContext({ headless: true })
  }
  try {
    const cookies = await c.cookies()
    const out = {}
    for (const [k, v] of Object.entries(COOKIE_CHECKS)) {
      const hasCookie = cookies.some((ck) => ck.domain.replace(/^\./, "").endsWith(v.domain) && v.names.includes(ck.name) && ck.value)
      out[k] = hasCookie && deep ? await probeLogin(c, k) : hasCookie
    }
    return out
  } finally {
    if (tmp) await tmp.close().catch(() => {})
  }
}

// In headless non si vede nulla: quando un passaggio fallisce salviamo uno screenshot
// in data/debug/ per capire cosa c'era davvero sulla pagina (banner, login, captcha...).
async function shot(page, label) {
  try {
    const dir = path.resolve(__dirname, CONFIG.dataDir, "debug")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.png`)
    await page.screenshot({ path: file })
    return file
  } catch {
    return null
  }
}

// I banner dei cookie coprono i pulsanti nei popup (soprattutto con un profilo nuovo).
// Scelta piu' rispettosa della privacy: rifiutare i cookie non essenziali.
async function dismissConsent(page) {
  const reject = page
    .locator(
      '#onetrust-reject-all-handler, button:text-matches("^(Rifiuta tutti|Rifiuta tutto|Reject all|Decline optional cookies|Rifiuta cookie facoltativi)$", "i")'
    )
    .first()
  try {
    await reject.waitFor({ state: "visible", timeout: 4000 })
    await reject.click({ timeout: 3000 })
    await sleep(600)
  } catch {}
}

// ---------- SoundCloud: azioni REALI nel popup aperto dal gate ----------
// Il gate apre un popup su soundcloud.com per ogni azione richiesta (follow / like / repost):
// qui facciamo davvero quell'azione col tuo account loggato. Mai toggle alla cieca: se
// l'azione risulta gia' attiva non clicchiamo (cosi' non si toglie un like/follow esistente),
// e dopo il clic verifichiamo che sia davvero attiva.
const SC_BUTTONS = {
  // il gate apre il PROFILO dell'artista per il follow: li' c'e' un solo pulsante follow
  // ATTENZIONE: mai selettori generici tipo "button.sc-button-like": il player in basso
  // (.playbackSoundBadge) ha i SUOI pulsanti like/follow, relativi a un altro brano.
  follow: ["button.sc-button-follow:not(.playbackSoundBadge__follow)", ".listenArtistInfo button.sc-button-follow"],
  like: [".listenEngagement__actions button.sc-button-like", ".soundActions button.sc-button-like"],
  repost: [".listenEngagement__actions button.sc-button-repost", ".soundActions button.sc-button-repost"],
}
// Con l'account loggato SoundCloud serve la pagina del brano dentro un iframe (UI nuova, MUI):
// li' i pulsanti si riconoscono dall'etichetta accessibile (la prima occorrenza e' il brano
// principale, i commenti vengono dopo). Include sia lo stato "off" sia "on".
const SC_FRAME_LABEL = {
  like: /^(mi piace|non mi piace più|like|unlike|liked)$/i,
  // off: "Ripubblica" / "Repost"; on: "Rimuovi post/Modifica ripubblicazione" (verificato) e simili
  repost: /ripubblic|repost/i,
}
async function findScButton(popup, kind, timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    for (const sel of SC_BUTTONS[kind] || []) {
      const loc = popup.locator(sel).first()
      if (await loc.isVisible().catch(() => false)) return loc
    }
    const re = SC_FRAME_LABEL[kind]
    if (re) {
      for (const f of popup.frames()) {
        if (f === popup.mainFrame()) continue
        const loc = f.getByRole("button", { name: re }).first()
        if (await loc.isVisible().catch(() => false)) return loc
      }
    }
    await sleep(500)
  }
  return null
}
// testi/etichette che indicano un'azione GIA' attiva (SoundCloud in inglese e italiano)
const SC_ON = "unfollow|unlike|unrepost|undo repost|non seguire|smetti di seguire|non mi piace|annulla|rimuovi post|modifica ripubblicazione|remove post|edit repost|seguendo|following|liked|reposted|ripubblicato"

async function scButtonIsOn(btn) {
  return btn.evaluate(
    (el, reSrc) =>
      el.classList.contains("sc-button-selected") ||
      el.getAttribute("aria-pressed") === "true" ||
      new RegExp(reSrc, "i").test(`${el.title} ${el.getAttribute("aria-label") || ""} ${el.innerText}`),
    SC_ON
  )
}

// true se il testo di una qualunque frame della pagina combacia
async function scPageSays(popup, re) {
  for (const f of popup.frames()) {
    const t = await f.evaluate(() => document.body.innerText).catch(() => "")
    if (re.test(t)) return true
  }
  return false
}

// Ritorna "already" | "done" | "missing" (profilo/brano inesistente) | false
async function doSoundCloudAction(popup, kind, log) {
  // i popup nascono piccoli (~500px): SoundCloud passa al layout compatto e nasconde i pulsanti
  await popup.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  await popup.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {})
  await dismissConsent(popup)
  await sleep(3000)
  if (await scPageSays(popup, /non abbiamo trovato l'utente|non abbiamo trovato la pagina|questa traccia non è stata trovata|we can't find that user|we couldn't find that user|we can't find that page|this track was not found/i)) {
    log(`SoundCloud ${kind}: la pagina indicata dal gate non esiste (profilo/brano rimosso), salto`)
    return "missing"
  }
  const btn = await findScButton(popup, kind)
  if (!btn) {
    log(`SoundCloud ${kind}: pulsante non trovato nel popup (pagina cambiata o account non collegato?)`)
    const cands = []
    for (const f of popup.frames()) {
      const rows = await f
        .evaluate(() =>
          [...document.querySelectorAll("button")]
            .filter((b) => b.offsetParent && !b.classList.contains("playableTile__actionButton"))
            .slice(0, 12)
            .map((b) => `${b.title || b.getAttribute("aria-label") || b.className.split(" ")[0]}`)
        )
        .catch(() => [])
      cands.push(...rows)
    }
    if (cands.length) log(`  pulsanti visibili: ${cands.join(" ; ")}`)
    return false
  }
  if (await scButtonIsOn(btn)) {
    log(`SoundCloud ${kind}: gia' attivo, non lo tocco`)
    return "already"
  }
  await sleep(600 + Math.random() * 700)
  await btn.click({ timeout: 8000 })
  // lo stato cambia in modo asincrono (e il repost apre un riquadro): aspetto fino a ~8s
  for (let t = 0; t < 10; t++) {
    await sleep(800)
    if (await scButtonIsOn(btn).catch(() => false)) {
      log(`SoundCloud ${kind}: fatto ✓`)
      return "done"
    }
    // il repost apre un riquadro modale ("Hai ripubblicato ...") che nasconde il pulsante
    if (kind === "repost" && (await scPageSays(popup, /hai ripubblicato|you reposted/i))) {
      log(`SoundCloud ${kind}: fatto ✓`)
      return "done"
    }
  }
  log(`SoundCloud ${kind}: non risulta attivo dopo il clic (login mancante?)`)
  return false
}

// Brani gia' commentati: evita di ripubblicare lo stesso commento se la coda viene rilanciata
const commentedFile = () => path.resolve(__dirname, CONFIG.dataDir, "commented.json")
function loadCommented() {
  try {
    return new Set(JSON.parse(fs.readFileSync(commentedFile(), "utf8")))
  } catch {
    return new Set()
  }
}
function saveCommented(set) {
  try {
    fs.mkdirSync(path.dirname(commentedFile()), { recursive: true })
    fs.writeFileSync(commentedFile(), JSON.stringify([...set], null, 1))
  } catch {}
}

// Commento pubblico sul brano (testo = CONFIG.comment). Ritorna "done" | "already" | false
async function doSoundCloudComment(popup, log) {
  const text = (CONFIG.comment || "").trim()
  if (!text) {
    log("SoundCloud comment: nessun testo impostato (Impostazioni > SoundCloud), la fai tu")
    return false
  }
  await popup.setViewportSize({ width: 1280, height: 900 }).catch(() => {})
  await popup.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {})
  const key = popup.url().split("?")[0]
  const commented = loadCommented()
  if (commented.has(key)) {
    log("SoundCloud comment: gia' pubblicato da questa app su questo brano, non lo ripeto")
    return "already"
  }
  await dismissConsent(popup)
  const t0 = Date.now()
  let box = null
  let frame = null
  while (Date.now() - t0 < 25000 && !box) {
    for (const f of popup.frames()) {
      const loc = f.locator('input[type="text"][placeholder*="ommento" i], input[type="text"][placeholder*="omment" i]').first()
      if (await loc.isVisible().catch(() => false)) {
        box = loc
        frame = f
        break
      }
    }
    if (!box) await sleep(500)
  }
  if (!box) {
    log("SoundCloud comment: campo commento non trovato (commenti disabilitati?)")
    return false
  }
  await sleep(500 + Math.random() * 600)
  await box.click({ timeout: 8000 })
  await box.fill(text)
  const send = frame.getByRole("button", { name: /pubblica commento|post comment/i }).first()
  await sleep(500)
  await send.click({ timeout: 8000 })
  // fatto quando il campo si svuota
  for (let t = 0; t < 10; t++) {
    await sleep(800)
    const v = await box.inputValue().catch(() => null)
    if (v === "") {
      commented.add(key)
      saveCommented(commented)
      log("SoundCloud comment: fatto ✓")
      return "done"
    }
  }
  log("SoundCloud comment: non risulta pubblicato")
  return false
}

// Esegue follow/like/repost richiesti dallo step SoundCloud. true solo se TUTTE le azioni
// risultano realmente attive; altrimenti false (si passa alla conferma manuale).
async function autoSoundCloud(page, log) {
  // OGNI link e' un'azione distinta (es. due artisti da seguire): li scorro per indice
  const kinds = await page.$$eval("#step_sc a[data-step]", (els) => els.map((e) => e.getAttribute("data-step")))
  const seen = new Set(kinds)
  let allOk = true
  for (let idx = 0; idx < kinds.length; idx++) {
    const kind = kinds[idx]
    // il gate puo' ridisegnare i pulsanti dopo ogni azione: li ricerco ogni volta
    const link = page.locator("#step_sc a[data-step]").nth(idx)
    if (!SC_BUTTONS[kind] && kind !== "comment") {
      log(`SoundCloud: azione "${kind}" non automatizzabile, la fai tu`)
      allOk = false
      continue
    }
    if (aborted) return false
    let popup
    try {
      // clic sul link del gate via DOM: lo stesso onclick del clic vero, ma immune da
      // contenitori trasparenti che a volte intercettano il puntatore (visto sul pulsante Like)
      ;[popup] = await Promise.all([
        page.waitForEvent("popup", { timeout: 10000 }),
        link.evaluate((el) => el.click(), null, { timeout: 8000 }),
      ])
    } catch {
      log(`SoundCloud ${kind}: il popup non si e' aperto`)
      const f = await shot(page, `gate-nopopup-${kind}`)
      if (f) log(`Screenshot diagnostico: ${path.basename(f)}`)
      allOk = false
      continue
    }
    let failed = false
    try {
      const r = kind === "comment" ? await doSoundCloudComment(popup, log) : await doSoundCloudAction(popup, kind, log)
      if (!r) failed = true
    } catch (e) {
      log(`SoundCloud ${kind}: errore ${String(e.message).split("\n")[0]}`)
      failed = true
    } finally {
      if (failed) {
        allOk = false
        const f = await shot(popup, `sc-${kind}`)
        if (f) log(`Screenshot diagnostico: ${path.basename(f)}`)
      }
      await popup.close().catch(() => {})
    }
    await sleep(800 + Math.random() * 900)
  }
  return allOk && seen.size > 0
}

// ---------- Spotify: autorizzazione OAuth nel popup ----------
// Lo step Spotify del gate apre la pagina di consenso di Spotify: accettandola con il tuo
// account, e' Hypeddit a eseguire davvero i follow/salvataggi per l'artista.
async function autoSpotify(page, log) {
  let popup
  try {
    ;[popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 10000 }),
      // l'id e' duplicato nella pagina: prendo quello dentro lo step Spotify
      page.locator("#step_sp #login_to_sp").first().evaluate((el) => el.click(), null, { timeout: 8000 }),
    ])
  } catch {
    log("Spotify: il popup di autorizzazione non si e' aperto")
    return false
  }
  try {
    const accept = popup
      .locator('[data-testid="auth-accept"], button:has-text("Agree"), button:has-text("Accetto"), button:has-text("Accept")')
      .first()
    const loginForm = popup.locator('#login-username, input[name="username"]').first()
    const state = await Promise.race([
      accept.waitFor({ state: "visible", timeout: 25000 }).then(() => "accept"),
      loginForm.waitFor({ state: "visible", timeout: 25000 }).then(() => "login"),
      new Promise((res) => popup.once("close", () => res("closed"))),
    ]).catch(() => "timeout")

    if (state === "login") {
      log("Spotify: account non collegato (richiesto il login)")
      await shot(popup, "sp-login")
      return false
    }
    if (state === "timeout") {
      log("Spotify: nessuna pagina di consenso riconosciuta")
      await shot(popup, "sp-timeout")
      return false
    }
    if (state === "accept") {
      await sleep(500 + Math.random() * 600)
      await accept.click({ timeout: 8000 })
      log("Spotify: consenso accettato ✓")
      await popup.waitForEvent("close", { timeout: 15000 }).catch(() => {})
    } else {
      log("Spotify: gia' autorizzato ✓")
    }
    return true
  } catch (e) {
    log(`Spotify: errore ${String(e.message).split("\n")[0]}`)
    await shot(popup, "sp-errore")
    return false
  } finally {
    await popup.close().catch(() => {})
  }
}

// ---------- Instagram: follow nel popup del profilo ----------
const IG_FOLLOWING = /^(following|seguiti|segui gi|requested|richiesta inviata)/i
const IG_FOLLOW = /^(follow|segui|follow back|ricambia)$/i

async function autoInstagram(page, log) {
  const links = await page.$$("#instagram_status a")
  if (!links.length) {
    log("Instagram: nessun link di follow trovato nello step")
    return false
  }
  let allOk = true
  for (const link of links) {
    if (aborted) return false
    let popup
    try {
      ;[popup] = await Promise.all([
        page.waitForEvent("popup", { timeout: 10000 }),
        link.evaluate((el) => el.click()),
      ])
    } catch {
      log("Instagram: il popup non si e' aperto")
      allOk = false
      continue
    }
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {})
      await dismissConsent(popup)
      const loginForm = popup.locator('input[name="username"]').first()
      const followed = popup.getByRole("button", { name: IG_FOLLOWING }).first()
      const follow = popup.getByRole("button", { name: IG_FOLLOW }).first()
      const state = await Promise.race([
        followed.waitFor({ state: "visible", timeout: 20000 }).then(() => "already"),
        follow.waitFor({ state: "visible", timeout: 20000 }).then(() => "follow"),
        loginForm.waitFor({ state: "visible", timeout: 20000 }).then(() => "login"),
      ]).catch(() => "timeout")

      if (state === "already") {
        log("Instagram: gia' seguito, non lo tocco")
      } else if (state === "follow") {
        await sleep(700 + Math.random() * 800)
        await follow.click({ timeout: 8000 })
        await sleep(2000)
        const ok = await followed.isVisible().catch(() => false)
        log(ok ? "Instagram: follow fatto ✓" : "Instagram: il follow non risulta attivo dopo il clic")
        if (!ok) allOk = false
      } else {
        log(state === "login" ? "Instagram: account non collegato (richiesto il login)" : "Instagram: pulsante follow non trovato")
        await shot(popup, "ig-" + state)
        allOk = false
      }
    } catch (e) {
      log(`Instagram: errore ${String(e.message).split("\n")[0]}`)
      allOk = false
    } finally {
      await popup.close().catch(() => {})
    }
    await sleep(800 + Math.random() * 900)
  }
  return allOk
}

// ---------- una traccia ----------
// Modalita' senza interazione: se un passaggio non si riesce ad automatizzare la traccia
// viene segnata "da fare a mano" e la coda prosegue. Nessuna attesa dell'utente.
// `site` (soundcloud|spotify|instagram) indica che il fallimento potrebbe essere un account
// scaduto: il server lo verifica e, se e' cosi', ferma la coda invece di bruciarla.
class NeedsManual extends Error {
  constructor(message, site) {
    super(message)
    this.site = site || null
  }
}

async function currentStepClass(page) {
  return page.$eval(CONFIG.sel.currentStep, (el) => el.className).catch(() => null)
}

// Attende che il gate avanzi (lo step corrente cambia). NON forza lo stato.
async function waitForStepChange(page, prevClass, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (aborted) return null
    const cls = await currentStepClass(page)
    if (cls && cls !== prevClass) return cls
    await sleep(800)
  }
  return null
}

// Il gate tiene due pulsanti "Next" per step (uno nascosto): clicco solo quello visibile
const stepNext = (page, key) =>
  page
    .locator(`#skipper_${key}_channel, #skipper_${key}_next`)
    .and(page.locator(":visible"))
    .first()
    .click({ timeout: 5000 })
    .catch(() => {})

// Ritorna { status: "downloaded" | "needs-manual" | "no-download" | "stopped", file?, reason? }
export async function processTrack(url, log) {
  await ensureBrowser(log)
  const page = await ctx.newPage()
  let result = { status: "no-download" }
  const done = new Set() // automazioni gia' tentate in questa traccia (mai due volte)
  try {
    log(`Apro ${url}`)
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
    await sleep(1500)

    // 1. "Get this track"
    await page.click(CONFIG.sel.getTrackButton, { timeout: 8000 }).catch(() => {
      log(`Pulsante "${CONFIG.sel.getTrackButton}" non trovato: controlla il selettore in Impostazioni > Avanzate`)
    })
    await sleep(1200)

    // 2. Scorri gli step del gate finche' non arrivi al download
    for (let i = 0; i < 12; i++) {
      if (aborted) {
        result = { status: "stopped" }
        break
      }
      const cls = await currentStepClass(page)
      if (!cls) {
        await sleep(1000)
        continue
      }
      const has = (c) => cls.split(/\s+/).includes(c)
      const manual = (reason, site) => {
        throw new NeedsManual(reason, site)
      }

      if (has("dw")) {
        // STEP DOWNLOAD (meccanico)
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }).catch(() => null),
          page.click(CONFIG.sel.downloadButton).catch(() => {}),
        ])
        if (dl) {
          const dest = path.resolve(__dirname, CONFIG.downloadDir, dl.suggestedFilename())
          await dl.saveAs(dest)
          log(`Scaricato ✓ ${path.basename(dest)}`)
          result = { status: "downloaded", file: path.basename(dest) }
        } else {
          log("Nessun file catturato: il download potrebbe non essere partito")
        }
        break
      }

      if (has("email")) {
        if (!CONFIG.name || !CONFIG.email) manual("step email: nome/email non impostati")
        if (await page.locator("#gatePreviewCaptcha:not(.hide)").count()) manual("lo step email richiede un captcha")
        await page.fill(CONFIG.sel.emailName, CONFIG.name).catch(() => {})
        await page.fill(CONFIG.sel.emailAddress, CONFIG.email).catch(() => {})
        await page.click(CONFIG.sel.emailNext).catch(() => {})
        log("Email compilata")
        // la classe dello step cambia anche per le sole transizioni: aspetto che non sia piu' "email"
        let after = null
        for (let t = 0; t < 25 && !after && !aborted; t++) {
          await sleep(800)
          const c = await currentStepClass(page)
          if (c && !c.split(/\s+/).includes("email")) after = c
        }
        if (!after) {
          const errs = await page
            .$$eval(".name_error_email_name, .name_error_email, .hype-invalid-feedback", (els) =>
              els.map((e) => e.innerText.trim()).filter(Boolean)
            )
            .catch(() => [])
          const f = await shot(page, "email")
          if (f) log(`Screenshot diagnostico: ${path.basename(f)}`)
          manual(`step email non accettato dal gate${errs.length ? ` (${errs.join("; ")})` : ""}`)
        }
        log(`Step email: ${cls.trim()} -> ${after.trim()}`)
        continue
      }

      if (has("sc")) {
        if (done.has("sc")) manual("SoundCloud: il gate non e' avanzato")
        done.add("sc")
        if (CONFIG.comment) await page.fill(CONFIG.sel.scComment, CONFIG.comment).catch(() => {})
        const ok = await autoSoundCloud(page, log).catch((e) => {
          log(`SoundCloud: errore ${String(e.message).split("\n")[0]}`)
          return false
        })
        if (!ok) manual("SoundCloud: azioni non completate (account non collegato o pagina cambiata)", "soundcloud")
        await stepNext(page, "sc")
        if (!(await waitForStepChange(page, cls, 15000))) manual("SoundCloud: il gate non e' avanzato")
        continue
      }

      if (has("sp")) {
        if (done.has("sp")) manual("Spotify: il gate non e' avanzato")
        done.add("sp")
        if (!(await autoSpotify(page, log))) manual("Spotify: autorizzazione non riuscita (account non collegato?)", "spotify")
        if (!(await waitForStepChange(page, cls, 20000))) {
          await stepNext(page, "sp")
          if (!(await waitForStepChange(page, cls, 10000))) manual("Spotify: il gate non e' avanzato")
        }
        continue
      }

      if (has("ig")) {
        if (done.has("ig")) manual("Instagram: il gate non e' avanzato")
        done.add("ig")
        if (!(await autoInstagram(page, log))) manual("Instagram: follow non completato (account non collegato?)", "instagram")
        await stepNext(page, "ig")
        if (!(await waitForStepChange(page, cls, 15000))) manual("Instagram: il gate non e' avanzato")
        continue
      }

      // fb / yt / tk / mc / bc / dn ...: non automatizzati (nessun clic alla cieca sul gate)
      const other = ["fb", "yt", "tk", "mc", "bc", "dn"].find(has)
      if (other) manual(`step "${other}" non automatizzabile`)

      // step sconosciuto: aspetta un attimo
      await sleep(1500)
    }
  } catch (e) {
    if (e instanceof NeedsManual) {
      log(`DA FARE A MANO: ${e.message}`)
      result = { status: "needs-manual", reason: e.message, site: e.site || null }
    } else throw e
  } finally {
    await page.close().catch(() => {})
  }
  return result
}

// Pausa "umana" tra due tracce (base + jitter casuale), interrompibile
export async function pauseBetweenTracks(log) {
  const ms = CONFIG.betweenTracksMs + Math.floor(Math.random() * (CONFIG.betweenTracksJitterMs || 0))
  log(`Pausa ${Math.round(ms / 1000)}s prima della prossima traccia`)
  const end = Date.now() + ms
  while (Date.now() < end && !aborted) await sleep(500)
}
