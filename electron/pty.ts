import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import type { SessionOptions } from '../shared/types'

// Manages real PTY-backed shell sessions. Each terminal tab in the renderer
// maps 1:1 to an IPty here. Output is streamed back to the renderer over IPC.

interface Session {
  id: string
  proc: pty.IPty
  sender: WebContents
  lastProcess: string
  // Output coalescing: node-pty emits data in tiny chunks; forwarding each one
  // as its own IPC message piles up unboundedly if the renderer stalls (focus
  // loss, GC pause), pinning main-process memory. Buffer briefly and flush.
  outBuf: string[]
  outBytes: number
  outTimer: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<string, Session>()
let counter = 0
let processPoll: ReturnType<typeof setInterval> | null = null

// Small enough that a human doesn't perceive latency; large enough to coalesce
// hundreds of PTY chunks from a chatty program into one IPC round-trip.
const OUTPUT_FLUSH_MS = 8
const OUTPUT_FLUSH_BYTES = 64 * 1024

function flushOutput(s: Session): void {
  if (s.outTimer) {
    clearTimeout(s.outTimer)
    s.outTimer = null
  }
  if (s.outBuf.length === 0) return
  const data = s.outBuf.length === 1 ? s.outBuf[0] : s.outBuf.join('')
  s.outBuf = []
  s.outBytes = 0
  if (!s.sender.isDestroyed()) s.sender.send('session:data', s.id, data)
}

// Some children (nohup'd tasks, agents that setsid) survive their parent
// shell's exit and get reparented to init. Belt-and-suspenders: SIGKILL the
// whole process group so nothing outlives a session.
function killProcessGroup(pid: number): void {
  if (process.platform === 'win32' || !pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* group already gone */
  }
}

// Poll each PTY's foreground process name (node-pty's `process` reflects the
// active foreground program — `claude`, `vim`, `node`, the shell when idle).
// Renderer uses it to title tabs and flag which ones are busy.
function ensureProcessPoll(): void {
  if (processPoll) return
  processPoll = setInterval(() => {
    if (sessions.size === 0) {
      clearInterval(processPoll!)
      processPoll = null
      return
    }
    for (const s of sessions.values()) {
      let name = ''
      try {
        name = s.proc.process || ''
      } catch {
        /* pty gone */
      }
      if (name && name !== s.lastProcess) {
        s.lastProcess = name
        if (!s.sender.isDestroyed()) s.sender.send('session:process', s.id, name)
      }
    }
  }, 1000)
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

export function createSession(opts: SessionOptions, sender: WebContents): string {
  const id = `s${++counter}`
  const shell = defaultShell()

  const proc = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd,
    env: {
      ...process.env,
      // Make it obvious inside the shell which worktree this is.
      BONSAI_BRANCH: opts.branch,
      BONSAI_CWD: opts.cwd,
      TERM: 'xterm-256color',
    } as Record<string, string>,
  })

  const session: Session = {
    id,
    proc,
    sender,
    lastProcess: '',
    outBuf: [],
    outBytes: 0,
    outTimer: null,
  }
  sessions.set(id, session)

  proc.onData((data) => {
    session.outBuf.push(data)
    session.outBytes += data.length
    if (session.outBytes >= OUTPUT_FLUSH_BYTES) {
      flushOutput(session)
    } else if (!session.outTimer) {
      session.outTimer = setTimeout(() => flushOutput(session), OUTPUT_FLUSH_MS)
    }
  })
  proc.onExit(({ exitCode }) => {
    flushOutput(session)
    killProcessGroup(proc.pid)
    if (!sender.isDestroyed()) sender.send('session:exit', id, exitCode)
    sessions.delete(id)
  })

  ensureProcessPoll()
  return id
}

export function writeSession(id: string, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizeSession(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (s && cols > 0 && rows > 0) s.proc.resize(cols, rows)
}

export function killSession(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  if (s.outTimer) {
    clearTimeout(s.outTimer)
    s.outTimer = null
  }
  s.outBuf = []
  s.outBytes = 0
  const pid = s.proc.pid
  try {
    s.proc.kill()
  } catch {
    /* already gone */
  }
  // node-pty makes the shell a session leader, so the negative pid targets the
  // whole group — kills dev servers, background jobs, and detached children.
  killProcessGroup(pid)
  sessions.delete(id)
}

export function killAll(): void {
  for (const id of [...sessions.keys()]) killSession(id)
}
