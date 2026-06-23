import { create } from 'zustand'
import type {
  Repo,
  Branch,
  TabState,
  Worktree,
  GitStatus,
  DirEntry,
  AppConfig,
  Profile,
  SavedCommand,
  PrStatus,
  PullRequestDetail,
  PrComment,
  Commit,
  GhAccount,
  RunnableGroup,
  CodeDiffSource,
  TurnRecord,
} from '../shared/types'
import { applyTheme } from './themes'
import { modeValue } from './modes'

let tabCounter = 0
const nextTabId = () => `t${Date.now()}-${++tabCounter}`
let previewCounter = 0

/** Synthetic repo id for the scratch / Local terminal (no git, no branches). */
export const LOCAL_REPO_ID = '__local__'
export const LOCAL_BRANCH = 'local'
const isLocalTab = (t: TabState | undefined) => !!t && t.repoId === LOCAL_REPO_ID

export interface PreviewTab {
  id: string
  url: string
}


const branchKey = (repoId: string, branch: string) => `${repoId}::${branch}`

// Foreground-process helpers. A tab is "busy" when its PTY's foreground process
// is a real program rather than the idle login shell.
const SHELLS = new Set([
  'zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh', 'powershell', 'login', 'nu',
])
export function isShellProcess(name?: string): boolean {
  if (!name) return false
  const base = name.replace(/^-/, '').split('/').pop()!.toLowerCase()
  return SHELLS.has(base)
}
export function tabBusy(proc?: string): boolean {
  return !!proc && !isShellProcess(proc)
}
/** Best display name for a tab: live program title → process name → branch. */
export function tabDisplayName(tab: TabState, proc?: string): string {
  if (proc) return tabBusy(proc) ? tab.liveTitle || proc : tab.branch
  return tab.liveTitle || tab.branch
}

type InspectorView =
  | { kind: 'list' }
  | { kind: 'diff'; file: string; staged: boolean; diff: string }

export type DrawerPanel = 'changes' | 'files' | 'prs' | 'log' | 'turns'

/** Max turns retained per tab. Older ones drop off the end (LRU by start time). */
const MAX_TURNS_PER_TAB = 25
let turnCounter = 0
const nextTurnId = () => `tn${Date.now()}-${++turnCounter}`

type Modal =
  | { type: 'newBranch'; repoId: string }
  | { type: 'confirmDelete'; repoId: string; branch: string }
  | null

function applyConfig(c: AppConfig) {
  applyTheme(c.theme, {
    density: c.density,
    uiFont: c.uiFont,
    corners: c.corners,
    animations: c.animations,
    motion: c.motion ?? (c.animations ? 'normal' : 'none'),
    branchBarWidth: c.branchBarWidth ?? 'medium',
    tabStyle: c.tabStyle ?? 'filled',
    tabDensity: c.tabDensity ?? 'comfortable',
    topbarDensity: c.topbarDensity ?? 'comfortable',
    accent: c.accent,
    accentColor: c.accentColor,
    uiScale: c.uiScale,
    monoFont: c.monoFont,
    reduceTransparency: c.reduceTransparency,
  })
}

interface AppState {
  repos: Repo[]
  branchesByRepo: Record<string, Branch[]>
  worktrees: Record<string, Worktree>
  tabs: TabState[]
  activeTabId: string | null
  /** Sticky "I am in this repo" pointer. Survives closing the last tab in the repo. */
  activeRepoId: string | null
  expandedRepoIds: Set<string>
  expandedBranches: Set<string>
  loading: Set<string>

  scOpen: boolean
  panel: DrawerPanel
  statusByCwd: Record<string, GitStatus>
  inspector: InspectorView
  commitMessage: string
  syncing: string | null

  filesDir: string
  filesEntries: DirEntry[]

  sessionByTab: Record<string, string>
  processByTab: Record<string, string>
  /** Captured turns per tab id, most-recent first. */
  turnsByTab: Record<string, TurnRecord[]>
  /** Cached diff text per turn id, populated lazily on demand. */
  turnDiffById: Record<string, string>
  /** Which turn is currently being viewed in the Turns panel. */
  activeTurnId: string | null
  commandsByRepo: Record<string, SavedCommand[]>
  runnablesByCwd: Record<string, RunnableGroup[]>
  usageByRepo: Record<string, Record<string, number>>

  prStatus: PrStatus | null
  prDetail: PullRequestDetail | null
  prComments: PrComment[]
  prBusy: boolean
  ghAccounts: GhAccount[]

  commitsLog: Commit[]

  searchOpen: boolean
  branchFilter: string
  modal: Modal
  branchPrefsByRepo: Record<string, string[] | null>
  branchColorsByRepo: Record<string, Record<string, string>>
  branchPicker: string | null // repoId whose picker is open

  config: AppConfig | null
  settingsOpen: boolean
  paletteOpen: boolean

  previewTabs: PreviewTab[]
  activePane: string // 'terminal' or a preview tab id
  previewDetected: boolean

  init: () => Promise<void>
  addRepo: () => Promise<void>
  removeRepo: (id: string) => Promise<void>
  reorderRepos: (draggedId: string, targetId: string) => Promise<void>
  toggleRepo: (id: string) => Promise<void>
  refreshRepo: (id: string) => Promise<void>
  checkoutBranch: (repoId: string, branch: string) => Promise<void>
  reloadBranches: (repoId: string) => Promise<void>
  openBranch: (repoId: string, branch: string, forceNewTab?: boolean) => Promise<void>
  toggleBranch: (repoId: string, branch: string) => void
  setActiveTab: (id: string) => void
  setActiveRepo: (repoId: string) => void
  openLocalTerminal: () => Promise<void>
  closeTab: (id: string) => void
  setTabTitle: (id: string, title: string) => void
  setTabProcess: (id: string, name: string) => void
  syncBranchFromStatus: (tabId: string, actualBranch: string) => void
  selectTurn: (turnId: string | null) => Promise<void>
  endTurnNow: (tabId: string) => Promise<void>
  togglePinTab: (id: string) => void
  reorderTabs: (draggedId: string, targetId: string) => void
  persist: () => void

  activeTab: () => TabState | undefined
  toggleSourceControl: () => void
  setPanel: (p: DrawerPanel) => void
  refreshStatus: () => Promise<void>
  stage: (file: string) => Promise<void>
  unstage: (file: string) => Promise<void>
  discardFile: (file: string) => Promise<void>
  stageAll: () => Promise<void>
  commit: () => Promise<void>
  sync: (op: 'push' | 'pull' | 'fetch') => Promise<void>
  setCommitMessage: (m: string) => void
  openDiff: (file: string, staged: boolean) => Promise<void>
  backToList: () => void
  browseFiles: (relPath: string) => Promise<void>
  openCode: (file?: string, source?: CodeDiffSource) => void

  registerSession: (tabId: string, sessionId: string) => void
  unregisterSession: (tabId: string) => void
  runSaved: (cmd: SavedCommand) => void
  runCommandText: (command: string) => void
  loadRunnables: () => Promise<void>
  loadCommands: (repoId: string) => Promise<void>
  saveCommands: (repoId: string, list: SavedCommand[]) => Promise<void>
  toggleBookmark: (label: string, command: string) => void
  isBookmarked: (command: string) => boolean

  loadPrs: () => Promise<void>
  viewPr: (num: number) => Promise<void>
  createPr: (data: { title: string; body: string; draft?: boolean }) => Promise<string | null>
  editPr: (num: number, data: { title: string; body: string }) => Promise<void>
  addPrComment: (num: number, body: string) => Promise<void>
  reviewPr: (num: number, event: 'approve' | 'request-changes' | 'comment', body: string) => Promise<void>
  openPrInWindow: (num: number) => void
  closePrDetail: () => void
  prBranchOnly: boolean
  togglePrBranchOnly: () => void
  loadGhAccounts: () => Promise<void>
  switchGhAccount: (user: string) => Promise<void>

  loadLog: () => Promise<void>

  openPalette: () => void
  closePalette: () => void
  togglePreview: () => void
  setPaneActive: (id: string) => void
  addPreviewTab: (url?: string) => void
  closePreviewTab: (id: string) => void
  setPreviewTabUrl: (id: string, url: string) => void
  openPreviewWindow: (id: string) => void
  detectPreviewUrl: (url: string) => void
  isWebApp: () => boolean
  toggleSidebar: () => void
  setDrawerWidth: (w: number) => void
  revealActive: () => void
  openActiveInEditor: () => void
  newTabOnActive: () => void

  setSearchOpen: (v: boolean) => void
  setBranchFilter: (v: string) => void
  openModal: (m: Modal) => void
  closeModal: () => void
  createBranch: (repoId: string, name: string) => Promise<void>
  requestDeleteBranch: (repoId: string, branch: string) => void
  deleteBranch: (repoId: string, branch: string) => Promise<void>
  loadBranchPrefs: (repoId: string) => Promise<void>
  loadBranchColors: (repoId: string) => Promise<void>
  setBranchColor: (repoId: string, branch: string, colorId: string | null) => Promise<void>
  openBranchPicker: (repoId: string) => void
  closeBranchPicker: () => void
  setIncludedBranches: (repoId: string, names: string[]) => Promise<void>

  mode: (key: string) => boolean
  setSettingsOpen: (v: boolean) => void
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>
  setMode: (key: string, value: boolean) => Promise<void>
  saveProfile: (name: string) => Promise<void>
  applyProfile: (id: string) => Promise<void>
  deleteProfile: (id: string) => Promise<void>
}

export const useApp = create<AppState>((set, get) => ({
  repos: [],
  branchesByRepo: {},
  worktrees: {},
  tabs: [],
  activeTabId: null,
  activeRepoId: null,
  expandedRepoIds: new Set(),
  expandedBranches: new Set(),
  loading: new Set(),

  scOpen: false,
  panel: 'changes',
  statusByCwd: {},
  inspector: { kind: 'list' },
  commitMessage: '',
  syncing: null,

  filesDir: '',
  filesEntries: [],

  sessionByTab: {},
  processByTab: {},
  turnsByTab: {},
  turnDiffById: {},
  activeTurnId: null,
  commandsByRepo: {},
  runnablesByCwd: {},
  usageByRepo: {},

  prStatus: null,
  prDetail: null,
  prComments: [],
  prBusy: false,
  ghAccounts: [],
  prBranchOnly: false,

  commitsLog: [],

  searchOpen: false,
  branchFilter: '',
  modal: null,
  branchPrefsByRepo: {},
  branchColorsByRepo: {},
  branchPicker: null,

  config: null,
  settingsOpen: false,
  paletteOpen: false,

  previewTabs: [],
  activePane: 'terminal',
  previewDetected: false,

  init: async () => {
    let config = await window.bonsai.config.get()
    // One-shot migration: previous default 'modern' → new Codex aesthetic.
    if (config.theme === 'modern' && !config.profiles?.length) {
      config = await window.bonsai.config.set({ theme: 'codex' })
    }
    applyConfig(config)
    set({ config })

    const repos = await window.bonsai.repos.list()
    const { tabs, layout } = await window.bonsai.layout.load()
    const activeTabId = layout.activeTabId ?? tabs[0]?.id ?? null
    const activeFromTab = tabs.find((t) => t.id === activeTabId)?.repoId ?? null
    set({
      repos,
      tabs,
      activeTabId,
      activeRepoId: layout.activeRepoId ?? activeFromTab,
      expandedRepoIds: new Set(),
      expandedBranches: new Set(),
    })
    for (const r of repos) {
      void get().loadCommands(r.id)
      void get().loadBranchPrefs(r.id)
      void get().loadBranchColors(r.id)
    }
    void get().refreshStatus()
    void get().loadRunnables()
    // Local repo always keeps at least one open terminal so the pill is never
    // empty. Don't let this steal focus from the user's prior active selection.
    if (!get().tabs.some(isLocalTab)) {
      const prevActiveTab = get().activeTabId
      const prevActiveRepo = get().activeRepoId
      try {
        await get().openLocalTerminal()
        // Restore the user's prior focus — openLocalTerminal moved it to the new tab.
        if (prevActiveTab && prevActiveTab !== get().activeTabId) {
          set({ activeTabId: prevActiveTab, activeRepoId: prevActiveRepo })
        }
      } catch {
        /* homedir IPC missing in some dev contexts */
      }
    }
  },

  addRepo: async () => {
    const repo = await window.bonsai.repos.add()
    if (!repo) return
    set((s) => (s.repos.some((r) => r.id === repo.id) ? s : { repos: [...s.repos, repo] }))
    void get().loadCommands(repo.id)
    await get().toggleRepo(repo.id)
  },

  reorderRepos: async (draggedId, targetId) => {
    if (draggedId === targetId) return
    const repos = get().repos
    const from = repos.findIndex((r) => r.id === draggedId)
    const to = repos.findIndex((r) => r.id === targetId)
    if (from < 0 || to < 0) return
    const next = [...repos]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    set({ repos: next })
    try {
      await window.bonsai.repos.reorder(next.map((r) => r.id))
    } catch {
      // If persistence fails, revert so UI doesn't drift from disk.
      set({ repos })
    }
  },

  removeRepo: async (id) => {
    // Kill PTYs for any open terminals in this repo before dropping the tabs.
    for (const t of get().tabs) if (t.repoId === id) window.bonsai.session.kill(t.id)
    await window.bonsai.repos.remove(id)
    set((s) => {
      const repos = s.repos.filter((r) => r.id !== id)
      const tabs = s.tabs.filter((t) => t.repoId !== id)
      const processByTab = { ...s.processByTab }
      for (const t of s.tabs) if (t.repoId === id) delete processByTab[t.id]
      let activeRepoId = s.activeRepoId
      if (activeRepoId === id) {
        activeRepoId = repos[0]?.id ?? (tabs.some((t) => isLocalTab(t)) ? LOCAL_REPO_ID : null)
      }
      const activeTabId = s.activeTabId && tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : tabs.find((t) => t.repoId === activeRepoId)?.id ?? null
      return { repos, tabs, processByTab, activeRepoId, activeTabId }
    })
    get().persist()
  },

  toggleRepo: async (id) => {
    const expanded = new Set(get().expandedRepoIds)
    if (expanded.has(id)) {
      expanded.delete(id)
      set({ expandedRepoIds: expanded })
    } else {
      expanded.add(id)
      set((s) => ({ expandedRepoIds: expanded, loading: new Set(s.loading).add(id) }))
      await get().reloadBranches(id)
      set((s) => {
        const loading = new Set(s.loading)
        loading.delete(id)
        return { loading }
      })
    }
    get().persist()
  },

  // Fetch from the remote, then reload the branch list so new/updated branches
  // and HEAD state show up. Offline (no remote) just falls through to a reload.
  refreshRepo: async (id) => {
    set((s) => ({ loading: new Set(s.loading).add(id) }))
    try {
      await window.bonsai.git.fetch(id)
    } catch {
      /* offline / no remote */
    }
    try {
      await get().reloadBranches(id)
    } finally {
      set((s) => {
        const loading = new Set(s.loading)
        loading.delete(id)
        return { loading }
      })
    }
  },

  // Switch the primary checkout's HEAD. Because each opened branch lives in its
  // own worktree, checking one out as HEAD means removing that worktree — so we
  // confirm and then close its terminals once git frees it.
  checkoutBranch: async (repoId, branch) => {
    const key = branchKey(repoId, branch)
    const tabsHere = get().tabs.filter((t) => t.repoId === repoId && t.branch === branch)
    if (
      tabsHere.length &&
      !confirm(
        `"${branch}" is open in a worktree. Making it the primary HEAD will close its ` +
          `${tabsHere.length} terminal${tabsHere.length > 1 ? 's' : ''} and remove that worktree.\n\n` +
          `Continue?`,
      )
    ) {
      return
    }
    try {
      await window.bonsai.git.checkout(repoId, branch)
      // git freed the worktree — drop its terminals and stale worktree mapping.
      for (const t of tabsHere) window.bonsai.session.kill(t.id)
      set((s) => {
        const tabs = s.tabs.filter((t) => !(t.repoId === repoId && t.branch === branch))
        const worktrees = { ...s.worktrees }
        delete worktrees[key]
        const processByTab = { ...s.processByTab }
        for (const t of tabsHere) delete processByTab[t.id]
        const activeTabId = tabsHere.some((t) => t.id === s.activeTabId)
          ? (tabs[tabs.length - 1]?.id ?? null)
          : s.activeTabId
        return { tabs, worktrees, processByTab, activeTabId }
      })
      get().persist()
      await get().reloadBranches(repoId)
      void get().refreshStatus()
    } catch (err) {
      const msg = (err as Error).message
      // Surfaced by electron/git.ts checkout() when the primary checkout is
      // mid-rebase — offer to abort the rebase and retry the switch.
      if (msg.startsWith('__BONSAI_REBASE_IN_PROGRESS__:')) {
        const ok = confirm(
          `A rebase is in progress in this repo and is blocking the branch switch.\n\n` +
            `Abort the rebase (restoring the pre-rebase state) and switch to "${branch}"?`,
        )
        if (ok) {
          try {
            await window.bonsai.git.rebaseAbort(repoId)
            await get().checkoutBranch(repoId, branch)
          } catch (e) {
            alert(`Could not abort rebase:\n${(e as Error).message}`)
          }
        }
        return
      }
      alert(`Could not switch to ${branch}:\n${msg}`)
    }
  },

  reloadBranches: async (repoId) => {
    const branches = await window.bonsai.repos.branches(repoId)
    set((s) => ({ branchesByRepo: { ...s.branchesByRepo, [repoId]: branches } }))
    void get().loadBranchPrefs(repoId)
  },

  loadBranchPrefs: async (repoId) => {
    const prefs = await window.bonsai.branchPrefs.get(repoId)
    set((s) => ({ branchPrefsByRepo: { ...s.branchPrefsByRepo, [repoId]: prefs } }))
  },

  loadBranchColors: async (repoId) => {
    const colors = await window.bonsai.branchColors.get(repoId)
    set((s) => ({ branchColorsByRepo: { ...s.branchColorsByRepo, [repoId]: colors } }))
  },

  // Tag (or clear, when colorId is null) a branch's color, persisting the whole
  // per-repo map.
  setBranchColor: async (repoId, branch, colorId) => {
    const map = { ...(get().branchColorsByRepo[repoId] ?? {}) }
    if (colorId) map[branch] = colorId
    else delete map[branch]
    await window.bonsai.branchColors.set(repoId, map)
    set((s) => ({ branchColorsByRepo: { ...s.branchColorsByRepo, [repoId]: map } }))
  },

  openBranchPicker: (repoId) => set({ branchPicker: repoId }),
  closeBranchPicker: () => set({ branchPicker: null }),

  setIncludedBranches: async (repoId, names) => {
    await window.bonsai.branchPrefs.set(repoId, names)
    set((s) => ({ branchPrefsByRepo: { ...s.branchPrefsByRepo, [repoId]: names } }))
  },

  openBranch: async (repoId, branch, forceNewTab = false) => {
    const key = branchKey(repoId, branch)
    if (get().mode('autoFetchOnOpen')) {
      try {
        await window.bonsai.git.fetch(repoId)
      } catch {
        /* offline / no remote */
      }
    }
    const existing = get().tabs.find((t) => t.repoId === repoId && t.branch === branch)
    if (existing && !forceNewTab) {
      set((s) => ({
        activeTabId: existing.id,
        activeRepoId: repoId,
        activePane: 'terminal',
        expandedBranches: new Set(s.expandedBranches).add(key),
      }))
      get().persist()
      void get().refreshStatus()
    void get().loadRunnables()
      return
    }

    set((s) => ({ loading: new Set(s.loading).add(key) }))
    let worktree: Worktree
    try {
      worktree = await window.bonsai.worktree.ensure(repoId, branch)
    } catch (err) {
      set((s) => {
        const loading = new Set(s.loading)
        loading.delete(key)
        return { loading }
      })
      alert(`Could not create worktree for ${branch}:\n${(err as Error).message}`)
      return
    }

    const tab: TabState = { id: nextTabId(), repoId, branch, cwd: worktree.path, title: branch }
    set((s) => {
      const loading = new Set(s.loading)
      loading.delete(key)
      return {
        worktrees: { ...s.worktrees, [key]: worktree },
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        activeRepoId: repoId,
        activePane: 'terminal',
        expandedBranches: new Set(s.expandedBranches).add(key),
        loading,
      }
    })
    get().persist()
    void get().refreshStatus()
    void get().loadRunnables()
  },

  toggleBranch: (repoId, branch) => {
    const key = branchKey(repoId, branch)
    const expanded = new Set(get().expandedBranches)
    expanded.has(key) ? expanded.delete(key) : expanded.add(key)
    set({ expandedBranches: expanded })
    get().persist()
  },

  setActiveTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    set({
      activeTabId: id,
      activeRepoId: tab?.repoId ?? get().activeRepoId,
      inspector: { kind: 'list' },
      activePane: 'terminal',
    })
    get().persist()
    void get().refreshStatus()
    void get().loadRunnables()
  },

  // Switch the active repo without closing tabs. If the repo has tabs, focus the
  // most recent one; otherwise leave activeTabId null (the pane shows an empty
  // state for this repo).
  setActiveRepo: (repoId) => {
    const tabsInRepo = get().tabs.filter((t) => t.repoId === repoId)
    const nextTab = tabsInRepo[tabsInRepo.length - 1]
    set({
      activeRepoId: repoId,
      activeTabId: nextTab?.id ?? null,
      inspector: { kind: 'list' },
      activePane: 'terminal',
    })
    get().persist()
    void get().refreshStatus()
    void get().loadRunnables()
  },

  // Open a scratch shell in $HOME under the synthetic '__local__' repo. Has no
  // git/branch context — TabStrip renders these as flat chips.
  openLocalTerminal: async () => {
    const home = await window.bonsai.app.homeDir()
    const tab: TabState = {
      id: nextTabId(),
      repoId: LOCAL_REPO_ID,
      branch: LOCAL_BRANCH,
      cwd: home,
      title: 'local',
    }
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      activeRepoId: LOCAL_REPO_ID,
      activePane: 'terminal',
    }))
    get().persist()
  },

  closeTab: (id) => {
    // Guard against losing work: confirm if a real program is running in the tab.
    const proc = get().processByTab[id]
    if (tabBusy(proc) && !confirm(`"${proc}" is still running in this tab. Close it anyway?`)) {
      return
    }
    window.bonsai.session.kill(id)
    set((s) => {
      const closing = s.tabs.find((t) => t.id === id)
      const tabs = s.tabs.filter((t) => t.id !== id)
      const processByTab = { ...s.processByTab }
      delete processByTab[id]
      const turnsByTab = { ...s.turnsByTab }
      delete turnsByTab[id]
      let activeTabId = s.activeTabId
      if (s.activeTabId === id) {
        // Prefer the next tab in the SAME repo. If none, leave activeTabId null
        // (per-repo empty state) but keep activeRepoId so we don't jump repos.
        const sameRepo = tabs.filter((t) => closing && t.repoId === closing.repoId)
        activeTabId = sameRepo[sameRepo.length - 1]?.id ?? null
      }
      return { tabs, activeTabId, processByTab, turnsByTab }
    })
    get().persist()
    void get().refreshStatus()
    void get().loadRunnables()
    // Keep Local non-empty: if we just removed the last local tab, spawn a fresh
    // one in the background. Doesn't change focus.
    if (!get().tabs.some(isLocalTab)) {
      const prevActiveTab = get().activeTabId
      const prevActiveRepo = get().activeRepoId
      void get()
        .openLocalTerminal()
        .then(() => {
          if (prevActiveTab && prevActiveTab !== get().activeTabId) {
            set({ activeTabId: prevActiveTab, activeRepoId: prevActiveRepo })
          }
        })
        .catch(() => {})
    }
  },

  // Live program title (OSC) → tab name, falling back to the branch in the UI.
  // Runtime-only: not persisted (re-derived from the running program each launch).
  setTabTitle: (id, title) => {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 60)
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.liveTitle === (clean || undefined)) return
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, liveTitle: clean || undefined } : t)),
    }))
  },

  // Foreground process name for a tab's PTY (drives titles + busy indicator).
  // Also detects idle↔busy transitions and snapshots the worktree at each one
  // so the user can later view the diff for "what changed during this turn".
  setTabProcess: (id, name) => {
    const prev = get().processByTab[id]
    if (prev === name) return
    set((s) => ({ processByTab: { ...s.processByTab, [id]: name } }))

    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || isLocalTab(tab)) return
    const wasBusy = tabBusy(prev)
    const isBusy = tabBusy(name)

    // idle → busy: open a new turn with a pre-snapshot.
    if (!wasBusy && isBusy) {
      const turn: TurnRecord = {
        id: nextTurnId(),
        tabId: id,
        cwd: tab.cwd,
        command: name,
        startedAt: Date.now(),
        preRef: '',
      }
      // Push the placeholder immediately so the UI shows "in progress".
      set((s) => {
        const list = s.turnsByTab[id] ?? []
        const next = [turn, ...list].slice(0, MAX_TURNS_PER_TAB)
        return { turnsByTab: { ...s.turnsByTab, [id]: next } }
      })
      void window.bonsai.git
        .turnSnapshot(tab.cwd)
        .then((sha) => {
          set((s) => {
            const list = s.turnsByTab[id] ?? []
            return {
              turnsByTab: {
                ...s.turnsByTab,
                [id]: list.map((t) => (t.id === turn.id ? { ...t, preRef: sha } : t)),
              },
            }
          })
        })
        .catch(() => {})
      return
    }

    // busy → idle: close the most recent unfinished turn for this tab.
    if (wasBusy && !isBusy) {
      // A just-finished command may have switched branches — re-check this tab's
      // HEAD and relabel it if it drifted, even when it isn't the active tab.
      void window.bonsai.git
        .status(tab.cwd)
        .then((st) => get().syncBranchFromStatus(id, st.branch))
        .catch(() => {})

      const list = get().turnsByTab[id] ?? []
      const open = list.find((t) => !t.endedAt)
      if (!open) return
      void window.bonsai.git
        .turnSnapshot(tab.cwd)
        .then((sha) => {
          const endedAt = Date.now()
          set((s) => {
            const cur = s.turnsByTab[id] ?? []
            return {
              turnsByTab: {
                ...s.turnsByTab,
                [id]: cur.map((t) =>
                  t.id === open.id ? { ...t, postRef: sha, endedAt } : t,
                ),
              },
            }
          })
        })
        .catch(() => {})
    }
  },

  // Click handler for the Turns panel — fetches the diff once and caches it.
  selectTurn: async (turnId) => {
    set({ activeTurnId: turnId })
    if (!turnId) return
    if (get().turnDiffById[turnId]) return
    const turn = Object.values(get().turnsByTab)
      .flat()
      .find((t) => t.id === turnId)
    if (!turn) return
    const text = await window.bonsai.git.turnDiff(
      turn.cwd,
      turn.preRef,
      turn.postRef ?? '',
    )
    set((s) => ({ turnDiffById: { ...s.turnDiffById, [turnId]: text } }))
  },

  // Manual "end turn now" — useful when an AI runs inside a long-lived process
  // (dev server, REPL) that never returns to the idle shell.
  endTurnNow: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || isLocalTab(tab)) return
    const list = get().turnsByTab[tabId] ?? []
    const open = list.find((t) => !t.endedAt)
    if (!open) return
    const sha = await window.bonsai.git.turnSnapshot(tab.cwd)
    const endedAt = Date.now()
    set((s) => {
      const cur = s.turnsByTab[tabId] ?? []
      return {
        turnsByTab: {
          ...s.turnsByTab,
          [tabId]: cur.map((t) => (t.id === open.id ? { ...t, postRef: sha, endedAt } : t)),
        },
      }
    })
  },

  togglePinTab: (id) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)) }))
    get().persist()
  },

  // Move the dragged tab to the target tab's slot — but only within its own
  // group (same repo + pin state); cross-group drags are ignored.
  reorderTabs: (draggedId, targetId) => {
    if (draggedId === targetId) return
    let changed = false
    set((s) => {
      const tabs = [...s.tabs]
      const from = tabs.findIndex((t) => t.id === draggedId)
      const to = tabs.findIndex((t) => t.id === targetId)
      if (from === -1 || to === -1) return s
      const a = tabs[from]
      const b = tabs[to]
      // Only reorder among terminals of the same branch.
      if (a.repoId !== b.repoId || a.branch !== b.branch || !!a.pinned !== !!b.pinned) return s
      const [moved] = tabs.splice(from, 1)
      tabs.splice(to, 0, moved)
      changed = true
      return { tabs }
    })
    if (changed) get().persist()
  },

  persist: () => {
    const s = get()
    window.bonsai.layout.save({
      tabs: s.tabs,
      layout: {
        expandedRepoIds: [...s.expandedRepoIds],
        expandedBranches: [...s.expandedBranches],
        activeTabId: s.activeTabId,
        activeRepoId: s.activeRepoId,
      },
    })
  },

  // ---- Source control ----
  activeTab: () => get().tabs.find((t) => t.id === get().activeTabId),

  toggleSourceControl: () => {
    const next = !get().scOpen
    set({ scOpen: next, inspector: { kind: 'list' } })
    if (next) get().setPanel(get().panel)
  },

  setPanel: (p) => {
    set({ panel: p, inspector: { kind: 'list' } })
    if (p === 'changes') void get().refreshStatus()
    if (p === 'prs') void get().loadPrs()
    if (p === 'files') void get().browseFiles('')
    if (p === 'log') void get().loadLog()
  },

  refreshStatus: async () => {
    const tab = get().activeTab()
    if (!tab || isLocalTab(tab)) return
    try {
      const status = await window.bonsai.git.status(tab.cwd)
      set((s) => ({ statusByCwd: { ...s.statusByCwd, [tab.cwd]: status } }))
      // The checkout may have been switched out from under us (e.g. an agent ran
      // `git switch` in this terminal). Relabel the tab to match reality.
      get().syncBranchFromStatus(tab.id, status.branch)
    } catch (err) {
      console.error('status failed', err)
    }
  },

  // Reconcile a tab's branch label with the checkout's *actual* current branch.
  // External `git switch`/`git checkout` (commonly run by AI agents) silently
  // drift a checkout's HEAD; without this the tab keeps its old branch name.
  // Every tab pointing at the same cwd shares one HEAD, so they all move together.
  syncBranchFromStatus: (tabId, actualBranch) => {
    if (!actualBranch || actualBranch.startsWith('(')) return
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || isLocalTab(tab) || tab.branch === actualBranch) return
    const { repoId, cwd, branch: oldBranch } = tab
    const oldKey = branchKey(repoId, oldBranch)
    const newKey = branchKey(repoId, actualBranch)
    set((s) => {
      const tabs = s.tabs.map((t) =>
        t.repoId === repoId && t.cwd === cwd
          ? { ...t, branch: actualBranch, title: t.title === t.branch ? actualBranch : t.title }
          : t,
      )
      const worktrees = { ...s.worktrees }
      const prevWt = worktrees[oldKey]
      if (prevWt) {
        worktrees[newKey] = { ...prevWt, branch: actualBranch }
        delete worktrees[oldKey]
      }
      const expandedBranches = new Set(s.expandedBranches)
      if (expandedBranches.delete(oldKey)) expandedBranches.add(newKey)
      return { tabs, worktrees, expandedBranches }
    })
    void get().reloadBranches(repoId)
    get().persist()
  },

  stage: async (file) => {
    const tab = get().activeTab()
    if (!tab) return
    await window.bonsai.git.stage(tab.cwd, file)
    await get().refreshStatus()
  },

  unstage: async (file) => {
    const tab = get().activeTab()
    if (!tab) return
    await window.bonsai.git.unstage(tab.cwd, file)
    await get().refreshStatus()
  },

  discardFile: async (file) => {
    const tab = get().activeTab()
    if (!tab) return
    if (!confirm(`Discard all changes to ${file}? This can't be undone.`)) return
    await window.bonsai.git.discard(tab.cwd, file)
    await get().refreshStatus()
  },

  stageAll: async () => {
    const tab = get().activeTab()
    if (!tab) return
    await window.bonsai.git.stageAll(tab.cwd)
    await get().refreshStatus()
  },

  commit: async () => {
    const tab = get().activeTab()
    const msg = get().commitMessage.trim()
    if (!tab || !msg) return
    set({ syncing: 'Committing' })
    try {
      const status = get().statusByCwd[tab.cwd]
      if (get().mode('stageAllOnCommit') && status && !status.files.some((f) => f.staged)) {
        await window.bonsai.git.stageAll(tab.cwd)
      }
      await window.bonsai.git.commit(tab.cwd, msg)
      set({ commitMessage: '' })
      await get().refreshStatus()
    } catch (err) {
      alert(`Commit failed:\n${(err as Error).message}`)
    } finally {
      set({ syncing: null })
    }
  },

  sync: async (op) => {
    const tab = get().activeTab()
    if (!tab) return
    if (op === 'push' && get().mode('confirmBeforePush')) {
      if (!confirm(`Push ${tab.branch} to its remote?`)) return
    }
    set({ syncing: op === 'push' ? 'Pushing' : op === 'pull' ? 'Pulling' : 'Fetching' })
    try {
      if (op === 'push') await window.bonsai.git.push(tab.cwd)
      else if (op === 'pull') await window.bonsai.git.pull(tab.cwd)
      else await window.bonsai.git.fetch(tab.repoId)
      await get().refreshStatus()
    } catch (err) {
      const msg = (err as Error).message
      // Surfaced by electron/git.ts pull() when local changes or untracked files
      // would be clobbered — offer to stash everything, pull, and re-apply.
      if (op === 'pull' && msg === '__BONSAI_PULL_DIRTY_TREE__') {
        const ok = confirm(
          `Can't pull: your local changes (or new untracked files) would be overwritten ` +
            `by the incoming update.\n\n` +
            `Stash everything (including untracked files), pull, then re-apply your changes on top?`,
        )
        if (ok) {
          try {
            await window.bonsai.git.pullAutostash(tab.cwd)
          } catch (e) {
            const m = (e as Error).message
            if (m === '__BONSAI_PULL_AUTOSTASH_CONFLICT__') {
              alert(
                `Pulled successfully, but your stashed local changes couldn't be re-applied ` +
                  `cleanly (they overlap with what was pulled).\n\n` +
                  `Nothing was lost — your work is preserved in the stash. Reconcile it from a ` +
                  `terminal with "git stash list" then "git stash pop" / "git stash drop".`,
              )
            } else {
              alert(`Pull failed:\n${m}`)
            }
          }
          await get().refreshStatus()
        }
        return
      }
      alert(`${op} failed:\n${msg}`)
    } finally {
      set({ syncing: null })
    }
  },

  setCommitMessage: (m) => set({ commitMessage: m }),

  openDiff: async (file, staged) => {
    const tab = get().activeTab()
    if (!tab) return
    const diff = await window.bonsai.git.diffFile(tab.cwd, file, staged)
    set({ inspector: { kind: 'diff', file, staged, diff } })
  },

  backToList: () => set({ inspector: { kind: 'list' } }),

  browseFiles: async (relPath) => {
    const tab = get().activeTab()
    if (!tab) return
    try {
      const entries = await window.bonsai.git.listDir(tab.cwd, relPath)
      set({ filesDir: relPath, filesEntries: entries })
    } catch (err) {
      console.error('browse failed', err)
    }
  },

  openCode: (file = '', source) => {
    const tab = get().activeTab()
    if (!tab || isLocalTab(tab)) return
    void window.bonsai.window.openCode(tab.cwd, file, source)
  },

  // ---- Session registry + saved commands ----
  registerSession: (tabId, sessionId) =>
    set((s) => ({ sessionByTab: { ...s.sessionByTab, [tabId]: sessionId } })),

  unregisterSession: (tabId) =>
    set((s) => {
      const next = { ...s.sessionByTab }
      delete next[tabId]
      const processByTab = { ...s.processByTab }
      delete processByTab[tabId]
      return { sessionByTab: next, processByTab }
    }),

  runSaved: (cmd) => {
    const { activeTabId, sessionByTab } = get()
    if (!activeTabId) return
    const sid = sessionByTab[activeTabId]
    if (!sid) return
    if (cmd.action === 'paste') {
      // Drop the text at the prompt (no trailing newline) so it can be edited.
      window.bonsai.session.write(sid, cmd.commands.join('\n'))
    } else {
      for (const line of cmd.commands) {
        if (line.trim()) window.bonsai.session.write(sid, line + '\n')
      }
    }
  },

  runCommandText: (command) => {
    const tab = get().activeTab()
    if (!tab) return
    const sid = get().sessionByTab[tab.id]
    if (sid) window.bonsai.session.write(sid, `${command}\n`)
    // Track usage so frequently-run tasks can be surfaced.
    void window.bonsai.usage.bump(tab.repoId, command).then((counts) =>
      set((s) => ({ usageByRepo: { ...s.usageByRepo, [tab.repoId]: counts } })),
    )
  },

  loadRunnables: async () => {
    const tab = get().activeTab()
    if (!tab || isLocalTab(tab)) return
    try {
      const groups = await window.bonsai.git.runnables(tab.cwd)
      set((s) => ({ runnablesByCwd: { ...s.runnablesByCwd, [tab.cwd]: groups } }))
    } catch {
      /* ignore */
    }
    try {
      const counts = await window.bonsai.usage.get(tab.repoId)
      set((s) => ({ usageByRepo: { ...s.usageByRepo, [tab.repoId]: counts } }))
    } catch {
      /* ignore */
    }
  },

  loadCommands: async (repoId) => {
    const list = await window.bonsai.commands.list(repoId)
    set((s) => ({ commandsByRepo: { ...s.commandsByRepo, [repoId]: list } }))
  },

  saveCommands: async (repoId, list) => {
    await window.bonsai.commands.save(repoId, list)
    set((s) => ({ commandsByRepo: { ...s.commandsByRepo, [repoId]: list } }))
  },

  isBookmarked: (command) => {
    const tab = get().activeTab()
    if (!tab) return false
    const list = get().commandsByRepo[tab.repoId] ?? []
    return list.some((c) => c.commands.length === 1 && c.commands[0] === command)
  },

  toggleBookmark: (label, command) => {
    const tab = get().activeTab()
    if (!tab) return
    const list = get().commandsByRepo[tab.repoId] ?? []
    const existing = list.find((c) => c.commands.length === 1 && c.commands[0] === command)
    const next = existing
      ? list.filter((c) => c.id !== existing.id)
      : [...list, { id: `c${Date.now()}`, name: label, commands: [command], action: 'run' as const }]
    void get().saveCommands(tab.repoId, next)
  },

  // ---- Pull requests ----
  loadPrs: async () => {
    const tab = get().activeTab()
    if (!tab) return
    set({ prBusy: true, prDetail: null })
    try {
      const prStatus = await window.bonsai.pr.list(tab.cwd)
      set({ prStatus })
    } catch (err) {
      set({ prStatus: { available: false, reason: (err as Error).message } })
    } finally {
      set({ prBusy: false })
    }
    void get().loadGhAccounts()
  },

  loadGhAccounts: async () => {
    try {
      const ghAccounts = await window.bonsai.pr.accounts()
      set({ ghAccounts })
    } catch {
      /* gh missing */
    }
  },

  switchGhAccount: async (user) => {
    try {
      await window.bonsai.pr.switchAccount(user)
      await get().loadGhAccounts()
      await get().loadPrs()
    } catch (err) {
      alert(`Could not switch account:\n${(err as Error).message}`)
    }
  },

  viewPr: async (num) => {
    const tab = get().activeTab()
    if (!tab) return
    set({ prBusy: true, prComments: [] })
    try {
      const prDetail = await window.bonsai.pr.view(tab.cwd, num)
      set({ prDetail })
      // Comments load in the background; detail shows immediately.
      void window.bonsai.pr
        .comments(tab.cwd, num)
        .then((prComments) => set({ prComments }))
        .catch(() => {})
    } catch (err) {
      alert(`Could not load PR #${num}:\n${(err as Error).message}`)
    } finally {
      set({ prBusy: false })
    }
  },

  createPr: async (data) => {
    const tab = get().activeTab()
    if (!tab) return null
    set({ prBusy: true })
    try {
      const { url } = await window.bonsai.pr.create(tab.cwd, data)
      await get().loadPrs()
      return url
    } catch (err) {
      alert(`Could not create PR:\n${(err as Error).message}`)
      return null
    } finally {
      set({ prBusy: false })
    }
  },

  editPr: async (num, data) => {
    const tab = get().activeTab()
    if (!tab) return
    set({ prBusy: true })
    try {
      await window.bonsai.pr.edit(tab.cwd, num, data)
      await get().viewPr(num)
      await get().loadPrs()
    } catch (err) {
      alert(`Could not update PR:\n${(err as Error).message}`)
    } finally {
      set({ prBusy: false })
    }
  },

  addPrComment: async (num, body) => {
    const tab = get().activeTab()
    if (!tab || !body.trim()) return
    set({ prBusy: true })
    try {
      await window.bonsai.pr.comment(tab.cwd, num, body)
      const prComments = await window.bonsai.pr.comments(tab.cwd, num)
      set({ prComments })
    } catch (err) {
      alert(`Could not post comment:\n${(err as Error).message}`)
    } finally {
      set({ prBusy: false })
    }
  },

  reviewPr: async (num, event, body) => {
    const tab = get().activeTab()
    if (!tab) return
    set({ prBusy: true })
    try {
      await window.bonsai.pr.review(tab.cwd, num, event, body)
      const prComments = await window.bonsai.pr.comments(tab.cwd, num)
      set({ prComments })
    } catch (err) {
      alert(`Review failed:\n${(err as Error).message}`)
    } finally {
      set({ prBusy: false })
    }
  },

  openPrInWindow: (num) => {
    const tab = get().activeTab()
    if (tab) void window.bonsai.window.openPr(tab.cwd, num)
  },

  togglePrBranchOnly: () => set((s) => ({ prBranchOnly: !s.prBranchOnly })),

  closePrDetail: () => set({ prDetail: null, prComments: [] }),

  loadLog: async () => {
    const tab = get().activeTab()
    if (!tab) return
    try {
      const commitsLog = await window.bonsai.git.log(tab.cwd)
      set({ commitsLog })
    } catch (err) {
      console.error('log failed', err)
    }
  },

  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),

  togglePreview: () => {
    const { previewTabs, activePane } = get()
    if (activePane !== 'terminal') set({ activePane: 'terminal' })
    else if (previewTabs.length) set({ activePane: previewTabs[0].id })
    else get().addPreviewTab()
  },
  setPaneActive: (id) => set({ activePane: id }),

  addPreviewTab: (url = 'http://localhost:3000') => {
    const id = `pv${++previewCounter}`
    set((s) => ({
      previewTabs: [...s.previewTabs, { id, url }],
      activePane: id,
      previewDetected: true,
    }))
  },

  closePreviewTab: (id) =>
    set((s) => {
      const previewTabs = s.previewTabs.filter((t) => t.id !== id)
      const activePane =
        s.activePane === id ? (previewTabs[previewTabs.length - 1]?.id ?? 'terminal') : s.activePane
      return { previewTabs, activePane }
    }),

  setPreviewTabUrl: (id, url) =>
    set((s) => ({ previewTabs: s.previewTabs.map((t) => (t.id === id ? { ...t, url } : t)) })),

  openPreviewWindow: (id) => {
    const t = get().previewTabs.find((x) => x.id === id)
    if (t) void window.bonsai.window.openBrowser(t.url)
  },

  // Picks up dev-server URLs printed in the terminal (Vite/Next/Supabase/etc.).
  // One preview tab per distinct host:port; the first one auto-opens.
  detectPreviewUrl: (url) => {
    const clean = url.replace(/[)\].,'"]+$/, '')
    let origin: string
    try {
      origin = new URL(clean).origin
    } catch {
      return
    }
    const exists = get().previewTabs.some((t) => {
      try {
        return new URL(t.url).origin === origin
      } catch {
        return false
      }
    })
    if (exists) return
    const id = `pv${++previewCounter}`
    const firstEver = !get().previewDetected
    set((s) => ({
      previewTabs: [...s.previewTabs, { id, url: clean }],
      previewDetected: true,
      activePane: firstEver ? id : s.activePane,
    }))
  },

  // A repo is a "web app" if it has a dev/start/serve/preview script, OR if a
  // local server URL was detected in the terminal (covers non-npm setups).
  isWebApp: () => {
    if (get().previewDetected) return true
    const tab = get().activeTab()
    if (!tab) return false
    const groups = get().runnablesByCwd[tab.cwd] ?? []
    return groups.some((g) => g.items.some((i) => /\b(dev|start|serve|preview)\b/.test(i.label)))
  },

  toggleSidebar: () => {
    const c = get().config
    if (c) void get().updateConfig({ sidebarCollapsed: !c.sidebarCollapsed })
  },

  setDrawerWidth: (w) => {
    const width = Math.max(280, Math.min(720, Math.round(w)))
    const c = get().config
    if (c) void get().updateConfig({ drawerWidth: width })
  },

  revealActive: () => {
    const tab = get().activeTab()
    if (tab) void window.bonsai.app.reveal(tab.cwd)
  },

  openActiveInEditor: () => {
    const tab = get().activeTab()
    if (tab) void window.bonsai.app.openInEditor(tab.cwd)
  },

  newTabOnActive: () => {
    if (get().activeRepoId === LOCAL_REPO_ID) {
      void get().openLocalTerminal()
      return
    }
    const tab = get().activeTab()
    if (tab) void get().openBranch(tab.repoId, tab.branch, true)
  },

  // ---- Branch search + management ----
  setSearchOpen: (v) => set({ searchOpen: v, branchFilter: v ? get().branchFilter : '' }),
  setBranchFilter: (v) => set({ branchFilter: v }),
  openModal: (m) => set({ modal: m }),
  closeModal: () => set({ modal: null }),

  createBranch: async (repoId, name) => {
    const clean = name.trim()
    if (!clean) return
    try {
      await window.bonsai.git.createBranch(repoId, clean)
    } catch (err) {
      const msg = (err as Error).message
      // The branch already exists — that's not an error here. Fall through and
      // just reveal it (the user clearly wants to work on it).
      if (!/already exists/i.test(msg)) {
        alert(`Could not create branch:\n${msg}`)
        return
      }
    }
    await get().reloadBranches(repoId)
    // When the user has curated a branch subset, a freshly made branch would be
    // hidden — add it so it shows up immediately.
    const prefs = get().branchPrefsByRepo[repoId]
    if (prefs && !prefs.includes(clean)) {
      await get().setIncludedBranches(repoId, [...prefs, clean])
    }
    set({ modal: null })
    // Open it so it visibly "appears" (its own worktree + terminal tab).
    await get().openBranch(repoId, clean)
  },

  requestDeleteBranch: (repoId, branch) => {
    if (get().mode('confirmBeforeDelete')) {
      set({ modal: { type: 'confirmDelete', repoId, branch } })
    } else {
      void get().deleteBranch(repoId, branch)
    }
  },

  deleteBranch: async (repoId, branch) => {
    try {
      await window.bonsai.git.deleteBranch(repoId, branch, true)
      // Kill PTYs for any terminals on this branch — git just removed the worktree.
      const dead = get().tabs.filter((t) => t.repoId === repoId && t.branch === branch)
      for (const t of dead) window.bonsai.session.kill(t.id)
      set((s) => {
        const tabs = s.tabs.filter((t) => !(t.repoId === repoId && t.branch === branch))
        const processByTab = { ...s.processByTab }
        for (const t of dead) delete processByTab[t.id]
        const activeTabId = dead.some((t) => t.id === s.activeTabId)
          ? tabs.filter((t) => t.repoId === repoId).slice(-1)[0]?.id ?? null
          : s.activeTabId
        return { tabs, processByTab, activeTabId, modal: null }
      })
      await get().reloadBranches(repoId)
      get().persist()
    } catch (err) {
      alert(`Could not delete branch:\n${(err as Error).message}`)
    }
  },

  // ---- Config / settings ----
  mode: (key) => modeValue(get().config?.modes ?? {}, key),

  setSettingsOpen: (v) => set({ settingsOpen: v }),

  updateConfig: async (patch) => {
    const next = await window.bonsai.config.set(patch)
    applyConfig(next)
    set({ config: next })
  },

  setMode: async (key, value) => {
    const cur = get().config
    if (!cur) return
    await get().updateConfig({ modes: { ...cur.modes, [key]: value } })
  },

  saveProfile: async (name) => {
    const c = get().config
    if (!c || !name.trim()) return
    const profile: Profile = {
      id: `p${Date.now()}`,
      name: name.trim(),
      theme: c.theme,
      density: c.density,
      fontSize: c.fontSize,
      cursorBlink: c.cursorBlink,
      modes: { ...c.modes },
    }
    await get().updateConfig({ profiles: [...c.profiles, profile] })
  },

  applyProfile: async (id) => {
    const c = get().config
    const p = c?.profiles.find((x) => x.id === id)
    if (!p) return
    await get().updateConfig({
      theme: p.theme,
      density: p.density,
      fontSize: p.fontSize,
      cursorBlink: p.cursorBlink,
      modes: { ...p.modes },
    })
  },

  deleteProfile: async (id) => {
    const c = get().config
    if (!c) return
    await get().updateConfig({ profiles: c.profiles.filter((p) => p.id !== id) })
  },
}))

export { branchKey }
