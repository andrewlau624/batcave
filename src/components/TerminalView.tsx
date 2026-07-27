import { useEffect, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TabState } from '../../shared/types'
import { useApp } from '../store'
import { getTheme } from '../themes'
import { parseTerminalConfig } from '../terminalConfig'

const FONT_FAMILY = 'Menlo, "SF Mono", "JetBrains Mono", "Fira Code", Consolas, monospace'

// Matches local dev-server URLs printed by Vite/Next/Supabase/etc. (global, so
// a single chunk listing several ports yields a tab per port).
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s)'"]*/gi

// Quote a path for the shell only when it needs it (spaces / shell-special
// chars), matching how Finder/iTerm insert dropped file paths.
function shellQuote(p: string): string {
  return /[^\w@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p
}

/**
 * One xterm.js instance bound to one PTY session for the lifetime of a tab.
 * Inactive tabs stay mounted (hidden via CSS) so their shell state survives
 * tab switches.
 */
export function TerminalView({ tab, active }: { tab: TabState; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  const config = useApp((s) => s.config)
  const registerSession = useApp((s) => s.registerSession)
  const unregisterSession = useApp((s) => s.unregisterSession)
  const themeId = config?.theme ?? 'modern'

  // Ghostty-style terminal config overrides the base Appearance fields when set.
  const tc = useMemo(() => parseTerminalConfig(config?.terminalConfig ?? ''), [config?.terminalConfig])
  const fontFamily = tc.fontFamily || FONT_FAMILY
  const fontSize = tc.fontSize ?? config?.fontSize ?? 13
  const lineHeight = tc.lineHeight ?? 1
  const cursorBlink = tc.cursorBlink ?? config?.cursorBlink ?? true
  const cursorStyle = tc.cursorStyle ?? config?.cursorStyle ?? 'bar'
  const termTheme = { ...getTheme(themeId).terminal, ...(tc.theme ?? {}) }
  const paneStyle: CSSProperties =
    tc.paddingX != null || tc.paddingY != null
      ? { display: active ? 'block' : 'none', padding: `${tc.paddingY ?? 8}px ${tc.paddingX ?? 10}px` }
      : { display: active ? 'block' : 'none' }

  useEffect(() => {
    const term = new XTerm({
      fontFamily,
      fontSize,
      lineHeight,
      cursorBlink,
      cursorStyle,
      allowProposedApi: true,
      // Bound each tab's retained history. Default is 1000; 2000 gives useful
      // scrollback while keeping per-tab memory small when many tabs pile up.
      scrollback: 2000,
      theme: termTheme,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current!)
    // GPU-accelerated renderer. Must load after open(); silently falls back to
    // the default DOM renderer when WebGL2 is unavailable. Dispose on context
    // loss so xterm reverts to the DOM renderer instead of rendering nothing.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* WebGL2 unavailable — DOM renderer */
    }
    try {
      fit.fit()
    } catch {
      /* container not sized yet */
    }
    termRef.current = term
    fitRef.current = fit

    // Shift+Enter inserts a newline instead of submitting. We emit meta+Enter
    // (ESC + CR) — the sequence Claude Code's terminal-setup uses; readline and
    // most CLIs treat it as "insert newline" rather than "accept line".
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey) {
        const id = sessionIdRef.current
        if (id) window.bonsai.session.write(id, '\x1b\r')
        return false
      }
      return true
    })

    let disposed = false
    let offData = () => {}
    let offExit = () => {}
    let offProcess = () => {}

    // Auto-title: programs (claude, vim, shell precmd hooks…) emit an OSC title
    // escape; mirror it onto the tab, falling back to the branch when unset.
    const titleSub = term.onTitleChange((t) => useApp.getState().setTabTitle(tab.id, t))

    void (async () => {
      const id = await window.bonsai.session.create({
        repoId: tab.repoId,
        branch: tab.branch,
        cwd: tab.cwd,
        cols: term.cols,
        rows: term.rows,
      })
      if (disposed) {
        window.bonsai.session.kill(id)
        return
      }
      sessionIdRef.current = id
      registerSession(tab.id, id)
      offData = window.bonsai.session.onData((sid, data) => {
        if (sid !== id) return
        // xterm's write callback fires only after the internal parser has
        // consumed the chunk — the accurate back-pressure signal for main.
        // Without this ack, main can't bound its in-flight IPC queue and a
        // chatty program (agent output, tail -f, cat big-file) can balloon
        // RAM to tens of GB when the renderer stalls.
        term.write(data, () => window.bonsai.session.ack(id, data.length))
        const matches = data.match(LOCAL_URL_RE)
        if (matches) for (const url of matches) useApp.getState().detectPreviewUrl(url)
      })
      offExit = window.bonsai.session.onExit((sid) => {
        if (sid === id) term.writeln('\r\n\x1b[90m[process exited]\x1b[0m')
      })
      offProcess = window.bonsai.session.onProcess((sid, name) => {
        if (sid === id) useApp.getState().setTabProcess(tab.id, name)
      })
      term.onData((d) => window.bonsai.session.write(id, d))
    })()

    const refit = () => {
      const el = containerRef.current
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      const id = sessionIdRef.current
      if (id) window.bonsai.session.resize(id, term.cols, term.rows)
    }
    const ro = new ResizeObserver(refit)
    if (containerRef.current) ro.observe(containerRef.current)

    return () => {
      disposed = true
      ro.disconnect()
      offData()
      offExit()
      offProcess()
      titleSub.dispose()
      unregisterSession(tab.id)
      if (sessionIdRef.current) window.bonsai.session.kill(sessionIdRef.current)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live-apply theme / font / cursor / padding changes from Settings.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = termTheme
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    term.options.lineHeight = lineHeight
    term.options.cursorBlink = cursorBlink
    term.options.cursorStyle = cursorStyle
    try {
      fitRef.current?.fit()
      const id = sessionIdRef.current
      if (id) window.bonsai.session.resize(id, term.cols, term.rows)
    } catch {
      /* not visible yet */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId, fontFamily, fontSize, lineHeight, cursorBlink, cursorStyle, config?.terminalConfig])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      const term = termRef.current
      const el = containerRef.current
      if (!term || !el || el.clientWidth === 0) return
      try {
        fitRef.current?.fit()
      } catch {
        /* noop */
      }
      const id = sessionIdRef.current
      if (id) window.bonsai.session.resize(id, term.cols, term.rows)
      term.focus()
    })
  }, [active])

  return (
    <div
      className="term-pane"
      style={paneStyle}
      onClick={() => termRef.current?.focus()}
      onDragOver={(e) => {
        // Allow file drops; the path is dropped at the prompt to edit/run.
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer.files)
        if (files.length === 0) return
        e.preventDefault()
        const sid = sessionIdRef.current
        if (!sid) return
        const paths = files
          .map((f) => window.bonsai.app.pathForFile(f))
          .filter(Boolean)
          .map(shellQuote)
          .join(' ')
        if (paths) window.bonsai.session.write(sid, paths)
        termRef.current?.focus()
      }}
    >
      <div className="term-surface" ref={containerRef} />
    </div>
  )
}
