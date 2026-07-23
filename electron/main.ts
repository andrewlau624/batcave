import { app, BrowserWindow, Menu, nativeImage } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fixPath } from './fix-path'
import { registerIpc } from './ipc'
import { killAll } from './pty'
import { buildMenu } from './menu'
import { scheduleStartupCheck } from './updater'
import type { CodeDiffSource } from '../shared/types'

// Repair PATH before anything shells out to gh/git — a GUI launch (Finder/Dock)
// inherits a minimal PATH that omits Homebrew et al. See electron/fix-path.ts.
fixPath()

const ICON_PATH = path.join(app.getAppPath(), 'build', 'icon.png')
const APP_ICON = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined

// vite-plugin-electron sets this in dev; undefined in a packaged build.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// dist-electron/main.js lives next to preload; dist/ holds the built renderer.
const DIST_ELECTRON = __dirname
const DIST_RENDERER = path.join(__dirname, '../dist')

let win: BrowserWindow | null = null
const codeWindows = new Map<string, BrowserWindow>()

/** Open (or focus) a standalone code-viewer window for a worktree. */
export function openCodeWindow(cwd: string, file: string, source?: CodeDiffSource): void {
  const key = cwd
  const existing = codeWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    existing.webContents.send('code:navigate', { file, source })
    return
  }

  const cw = new BrowserWindow({
    width: 1100,
    height: 800,
    backgroundColor: '#0b0f14',
    titleBarStyle: 'hiddenInset',
    title: 'Bonsai — Code',
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  let params = `view=code&cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`
  if (source) {
    params += `&diff=${source.diff}`
    if (source.diff === 'worktree') params += `&staged=${source.staged ? 1 : 0}`
    else params += `&ref=${encodeURIComponent(source.ref)}`
  }
  if (DEV_SERVER_URL) {
    cw.loadURL(`${DEV_SERVER_URL}?${params}`)
  } else {
    cw.loadFile(path.join(DIST_RENDERER, 'index.html'), { search: params })
  }

  codeWindows.set(key, cw)
  cw.on('closed', () => codeWindows.delete(key))
}

const prWindows = new Map<string, BrowserWindow>()

/** Open a pull request in its own window. */
export function openPrWindow(cwd: string, num: number): void {
  const key = `${cwd}#${num}`
  const existing = prWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }
  const w = new BrowserWindow({
    width: 880,
    height: 860,
    backgroundColor: '#0b0f14',
    titleBarStyle: 'hiddenInset',
    title: `Bonsai — PR #${num}`,
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  const params = `view=pr&cwd=${encodeURIComponent(cwd)}&num=${num}`
  if (DEV_SERVER_URL) w.loadURL(`${DEV_SERVER_URL}?${params}`)
  else w.loadFile(path.join(DIST_RENDERER, 'index.html'), { search: params })
  prWindows.set(key, w)
  w.on('closed', () => prWindows.delete(key))
}

/** Open a plain browser window pointed at a URL (e.g. a local dev server). */
export function openBrowserWindow(url: string): void {
  const w = new BrowserWindow({
    width: 1100,
    height: 800,
    backgroundColor: '#ffffff',
    title: url,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  w.loadURL(url)
}

/** Open a single file's diff (from a PR or commit) in its own window. */
export function openDiffWindow(cwd: string, kind: string, ref: string, file: string): void {
  const w = new BrowserWindow({
    width: 1000,
    height: 820,
    backgroundColor: '#0b0f14',
    titleBarStyle: 'hiddenInset',
    title: `Bonsai — ${file}`,
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  const params =
    `view=diff&cwd=${encodeURIComponent(cwd)}&kind=${encodeURIComponent(kind)}` +
    `&ref=${encodeURIComponent(ref)}&file=${encodeURIComponent(file)}`
  if (DEV_SERVER_URL) w.loadURL(`${DEV_SERVER_URL}?${params}`)
  else w.loadFile(path.join(DIST_RENDERER, 'index.html'), { search: params })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 480,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    title: 'Bonsai',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(DIST_ELECTRON, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      // Chromium throttles background frames, which stalls the renderer's IPC
      // drain when the window loses focus. PTY output would then queue in the
      // main process unboundedly. Keep the renderer responsive.
      backgroundThrottling: false,
    },
  })

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(DIST_RENDERER, 'index.html'))
  }

  // Block whole-app reload (F5) — it would orphan running PTYs. ⌘R is handled
  // by the menu accelerator, which reloads only the active preview.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key?.toLowerCase() === 'f5') event.preventDefault()
  })

  win.on('closed', () => {
    win = null
  })
}

export function getMainWindow(): BrowserWindow | null {
  return win
}

// Right-click menu for previews (webviews) and the pop-out windows. The main
// app UI gets edit actions only (no navigation/reload of the app itself).
app.on('web-contents-created', (_e, contents) => {
  contents.on('context-menu', (_ev, params) => {
    const can = params.editFlags
    const isWebview = contents.getType() === 'webview'
    const isMainApp = !isWebview && BrowserWindow.fromWebContents(contents) === win
    const items: Electron.MenuItemConstructorOptions[] = []
    if (!isMainApp) {
      items.push(
        { label: 'Back', enabled: contents.canGoBack(), click: () => contents.goBack() },
        { label: 'Forward', enabled: contents.canGoForward(), click: () => contents.goForward() },
        { label: 'Reload', click: () => contents.reload() },
        { type: 'separator' },
      )
    }
    items.push(
      { role: 'cut', enabled: can.canCut },
      { role: 'copy', enabled: can.canCopy },
      { role: 'paste', enabled: can.canPaste },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Inspect element', click: () => contents.inspectElement(params.x, params.y) },
    )
    Menu.buildFromTemplate(items).popup()
  })
})

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock && APP_ICON) app.dock.setIcon(APP_ICON)
  registerIpc()
  buildMenu()
  createWindow()
  scheduleStartupCheck()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => killAll())
app.on('will-quit', () => killAll())
// Last-resort cleanup if the main process itself is told to exit.
process.on('exit', () => killAll())
process.on('SIGTERM', () => {
  killAll()
  app.quit()
})
