// Types shared between the Electron main process and the React renderer.

/** Any git operation that leaves state under `.git/` and blocks `git switch`. */
export type InProgressOp = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect'

export interface Repo {
  id: string
  name: string
  /** Absolute path to the primary checkout (the folder the user registered). */
  path: string
}

export interface Branch {
  name: string
  /** True if this is the branch currently checked out in the primary repo. */
  current: boolean
  /** Absolute worktree path if one already exists for this branch, else null. */
  worktreePath: string | null
}

/** Where the code viewer should source its +/- diff overlay from. */
export type CodeDiffSource =
  | { diff: 'worktree'; staged: boolean }
  | { diff: 'pr' | 'commit'; ref: string }

export interface Worktree {
  repoId: string
  branch: string
  /** Absolute path of the worktree the terminal should run in. */
  path: string
  /** Whether this is the repo's primary checkout (not a managed worktree). */
  primary: boolean
  /** Names of .env* files that were carried in (symlinked) from the primary checkout. */
  carriedEnvFiles: string[]
}

export interface SessionOptions {
  repoId: string
  branch: string
  /** Working directory the shell starts in (a worktree path). */
  cwd: string
  cols: number
  rows: number
}

export interface FileChange {
  path: string
  /** Staged status code from `git status` (e.g. 'M', 'A', ' '). */
  index: string
  /** Unstaged (working tree) status code. */
  working: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'
  staged: boolean
  unstaged: boolean
  insertions?: number
  deletions?: number
}

export interface GitStatus {
  branch: string
  tracking: string | null
  ahead: number
  behind: number
  files: FileChange[]
  clean: boolean
}

export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  /** Worktree-relative path. */
  path: string
}

export interface Commit {
  hash: string
  shortHash: string
  subject: string
  author: string
  relative: string
}

export interface RunnableGroup {
  source: string
  kind: 'npm' | 'make' | 'md'
  items: Array<{ label: string; command: string }>
}

/** A persisted terminal tab. */
export interface TabState {
  id: string
  repoId: string
  branch: string
  cwd: string
  title: string
  /** Live title reported by the running program via OSC (e.g. "Claude Code"). */
  liveTitle?: string
  /** Pinned tabs float to the front of the strip and stay put. */
  pinned?: boolean
}

export interface SavedCommand {
  id: string
  name: string
  /** One or more shell commands / text lines for the active terminal. */
  commands: string[]
  /** 'run' executes (sends a newline); 'paste' drops the text at the prompt to edit/reuse. */
  action: 'run' | 'paste'
}

export interface PullRequest {
  number: number
  title: string
  state: string
  url: string
  headRefName: string
  isDraft: boolean
  author: string
}

export interface PrCheck {
  name: string
  /** Normalized status: pass | fail | pending | skip | cancel. */
  bucket: 'pass' | 'fail' | 'pending' | 'skip' | 'cancel'
  link: string
  workflow?: string
}

export interface PrComment {
  author: string
  body: string
  createdAt: string
  /** A conversation comment or a review summary. */
  kind: 'comment' | 'review'
  /** Review state (APPROVED, CHANGES_REQUESTED, COMMENTED) when kind === 'review'. */
  state?: string
}

export interface PrCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  date: string
}

export interface PrFile {
  path: string
  additions: number
  deletions: number
}

export interface PrReviewComment {
  path: string
  line: number | null
  author: string
  body: string
  diffHunk: string
}

export interface PrCommitDetail {
  message: string
  files: PrFile[]
  /** Combined unified diff of everything the commit changed. */
  diff: string
}

export interface PullRequestDetail extends PullRequest {
  body: string
  baseRefName: string
  additions: number
  deletions: number
  commits: number
  checks: PrCheck[]
}

export type PrStatus =
  | { available: false; reason: string }
  | { available: true; prs: PullRequest[] }

export interface GhAccount {
  user: string
  active: boolean
}

export interface Profile {
  id: string
  name: string
  theme: string
  density: 'comfortable' | 'compact'
  fontSize: number
  cursorBlink: boolean
  modes: Record<string, boolean>
}

export type UiFont = 'system' | 'rounded' | 'mono' | 'serif'
export type Corners = 'sharp' | 'soft' | 'round'
export type CursorStyle = 'bar' | 'block' | 'underline'
export type UiScale = 'small' | 'normal' | 'large'
export type MonoFont = 'system' | 'jetbrains' | 'fira' | 'ibm' | 'commit' | 'mono45'
/** Animation intensity. Drives all UI transitions via CSS custom properties. */
export type Motion = 'none' | 'subtle' | 'normal' | 'expressive'
export type BranchBarWidth = 'thin' | 'medium' | 'thick'
export type TabStyle = 'filled' | 'outlined' | 'minimal'
export type TabDensity = 'compact' | 'comfortable' | 'spacious'
export type TopbarDensity = 'compact' | 'comfortable'

/** User-tunable configuration, persisted and editable as a JSON file. */
export interface AppConfig {
  theme: string
  density: 'comfortable' | 'compact'
  fontSize: number
  cursorBlink: boolean
  /** Interface font family style. */
  uiFont: UiFont
  /** Corner rounding style across the UI. */
  corners: Corners
  /** Terminal cursor shape. */
  cursorStyle: CursorStyle
  /** Whether UI transitions/animations play. Legacy; superseded by `motion`. */
  animations: boolean
  /** Animation intensity: none → expressive. Drives durations/easings/scale. */
  motion: Motion
  /** Width of the colored branch identity bar (left rectangle). */
  branchBarWidth: BranchBarWidth
  /** Visual style of terminal tabs: filled / outlined / minimal. */
  tabStyle: TabStyle
  /** Vertical density of the tab strip. */
  tabDensity: TabDensity
  /** Vertical density of the workspace topbar. */
  topbarDensity: TopbarDensity
  /** Accent color override id, 'custom', or 'theme' to use the theme's accent. */
  accent: string
  /** Custom accent hex used when accent === 'custom'. */
  accentColor: string
  /** Overall interface text scale. */
  uiScale: UiScale
  /** Monospace font family for terminals and code. */
  monoFont: MonoFont
  /** Disable backdrop blur / translucency on overlays. */
  reduceTransparency: boolean
  /** Ghostty-style terminal config (key = value lines). Overrides the terminal
   * pane's font / cursor / theme / padding when set. Empty = use the fields above. */
  terminalConfig: string
  /** Syntax-highlight code in the viewer. */
  syntaxHighlight: boolean
  /** Show line numbers in the code viewer. */
  codeLineNumbers: boolean
  /** Layout preferences. */
  sidebarCollapsed: boolean
  drawerWidth: number
  /** Overrides for the mode toggles defined in the renderer (key -> on/off). */
  modes: Record<string, boolean>
  profiles: Profile[]
}

/** Persisted UI layout, reloaded on next launch. */
/** A captured "turn" in a tab — bounded by foreground process going busy→idle. */
export interface TurnRecord {
  id: string
  tabId: string
  /** Working dir snapshotted (the tab's worktree path). */
  cwd: string
  /** Foreground program when the turn started (claude, codex, npm, …). */
  command: string
  startedAt: number
  endedAt?: number
  /** Dangling commit SHA from `git stash create -u` at turn start. '' = clean tree. */
  preRef: string
  /** Same, at turn end. Missing while the turn is still in progress. */
  postRef?: string
}

export interface LayoutState {
  expandedRepoIds: string[]
  expandedBranches: string[] // `${repoId}::${branch}`
  activeTabId: string | null
  /** Which repo (or '__local__') the user is currently focused on. Sticky across tab close/switch. */
  activeRepoId?: string | null
}

/** The API exposed on `window.bonsai` by the preload script. */
export interface BonsaiApi {
  repos: {
    list(): Promise<Repo[]>
    add(): Promise<Repo | null>
    remove(id: string): Promise<void>
    /** Persist a new repo order. Missing ids are appended at the end. */
    reorder(orderedIds: string[]): Promise<Repo[]>
    branches(repoId: string): Promise<Branch[]>
  }
  worktree: {
    ensure(repoId: string, branch: string): Promise<Worktree>
  }
  git: {
    status(cwd: string): Promise<GitStatus>
    stage(cwd: string, file: string): Promise<void>
    unstage(cwd: string, file: string): Promise<void>
    stageAll(cwd: string): Promise<void>
    commit(cwd: string, message: string): Promise<void>
    push(cwd: string): Promise<string>
    pull(cwd: string): Promise<string>
    /** Stash (incl. untracked), pull, then re-apply — used after a dirty-tree pull refusal. */
    pullAutostash(cwd: string): Promise<string>
    fetch(repoId: string): Promise<void>
    /** Switch the primary checkout's HEAD to `branch` (git switch). */
    checkout(repoId: string, branch: string): Promise<void>
    /** Stash (incl. untracked), switch, then re-apply — used after a dirty-tree switch refusal. */
    checkoutAutostash(repoId: string, branch: string): Promise<void>
    /** Which in-progress operation (if any) is blocking `git switch`. */
    inProgressOp(repoId: string): Promise<InProgressOp | null>
    /** Abort whatever operation is in progress, restoring HEAD. */
    abortInProgressOp(repoId: string): Promise<void>
    createBranch(repoId: string, name: string, from?: string): Promise<void>
    deleteBranch(repoId: string, name: string, force?: boolean): Promise<void>
    diffFile(cwd: string, file: string, staged: boolean): Promise<string>
    discard(cwd: string, file: string): Promise<void>
    readFile(cwd: string, relPath: string): Promise<{ content: string; truncated: boolean }>
    /** Save UTF-8 content to a file inside a worktree. Path is sandboxed to cwd. */
    writeFile(cwd: string, relPath: string, content: string): Promise<void>
    listDir(cwd: string, relPath: string): Promise<DirEntry[]>
    log(cwd: string): Promise<Commit[]>
    /** Snapshot the working tree + untracked files into a dangling commit. SHA returned (or '' if clean). */
    turnSnapshot(cwd: string): Promise<string>
    /** Diff between two refs (use the SHAs from turnSnapshot). Returns unified diff text. */
    turnDiff(cwd: string, baseRef: string, headRef: string): Promise<string>
    scripts(cwd: string): Promise<Array<{ name: string; command: string }>>
    makeTargets(cwd: string): Promise<string[]>
    runnables(cwd: string): Promise<RunnableGroup[]>
  }
  session: {
    create(opts: SessionOptions): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(cb: (id: string, data: string) => void): () => void
    onExit(cb: (id: string, code: number) => void): () => void
    /** Fires when a session's foreground process name changes (for tab titles / busy state). */
    onProcess(cb: (id: string, name: string) => void): () => void
  }
  layout: {
    load(): Promise<{ tabs: TabState[]; layout: LayoutState }>
    save(state: { tabs: TabState[]; layout: LayoutState }): Promise<void>
  }
  config: {
    get(): Promise<AppConfig>
    set(patch: Partial<AppConfig>): Promise<AppConfig>
    path(): Promise<string>
    reveal(): Promise<void>
  }
  commands: {
    list(repoId: string): Promise<SavedCommand[]>
    save(repoId: string, list: SavedCommand[]): Promise<void>
  }
  usage: {
    get(repoId: string): Promise<Record<string, number>>
    bump(repoId: string, command: string): Promise<Record<string, number>>
  }
  branchPrefs: {
    /** Included branch names, or null if the repo hasn't been curated (= show all). */
    get(repoId: string): Promise<string[] | null>
    set(repoId: string, names: string[]): Promise<void>
  }
  branchColors: {
    /** Map of branch name -> color id for a repo (empty if none set). */
    get(repoId: string): Promise<Record<string, string>>
    set(repoId: string, map: Record<string, string>): Promise<void>
  }
  pr: {
    list(cwd: string): Promise<PrStatus>
    view(cwd: string, num: number): Promise<PullRequestDetail>
    comments(cwd: string, num: number): Promise<PrComment[]>
    create(
      cwd: string,
      data: { title: string; body: string; base?: string; draft?: boolean },
    ): Promise<{ url: string }>
    edit(cwd: string, num: number, data: { title: string; body: string }): Promise<void>
    comment(cwd: string, num: number, body: string): Promise<void>
    commits(cwd: string, num: number): Promise<PrCommit[]>
    commitDiff(cwd: string, sha: string): Promise<PrCommitDetail>
    files(cwd: string, num: number): Promise<PrFile[]>
    diff(cwd: string, num: number): Promise<string>
    reviewComments(cwd: string, num: number): Promise<PrReviewComment[]>
    review(
      cwd: string,
      num: number,
      event: 'approve' | 'request-changes' | 'comment',
      body: string,
    ): Promise<void>
    accounts(): Promise<GhAccount[]>
    switchAccount(user: string): Promise<void>
    /** Fetch the CI log for a check given its details URL. */
    checkLog(cwd: string, link: string): Promise<string>
  }
  window: {
    /** Open the standalone code viewer window for a worktree (optionally at a file).
     * When `source` is given, the viewer overlays +/- change markers in the gutter. */
    openCode(cwd: string, file: string, source?: CodeDiffSource): Promise<void>
    /** (Code window) fired when the main window requests navigation to a file. */
    onNavigate(cb: (payload: { file: string; source?: CodeDiffSource }) => void): () => void
    /** Open a pull request in its own window. */
    openPr(cwd: string, num: number): Promise<void>
    /** Open a single file's diff (+/-) from a PR or commit in its own window. */
    openDiff(cwd: string, kind: 'pr' | 'commit', ref: string, file: string): Promise<void>
    /** Open a URL (e.g. a local dev server) in a plain browser window. */
    openBrowser(url: string): Promise<void>
  }
  openExternal(url: string): Promise<void>
  /** Set the renderer page zoom factor (whole-window scale). */
  setZoom(factor: number): void
  app: {
    /** Open a folder/file in the OS file manager. */
    reveal(path: string): Promise<void>
    /** Open a path in the user's editor (VS Code if available). Resolves to true on success. */
    openInEditor(path: string): Promise<boolean>
    /** Resolve the absolute filesystem path of a dropped File (Electron webUtils). */
    pathForFile(file: File): string
    /** The user's home directory (used for the scratch / Local terminal). */
    homeDir(): Promise<string>
  }
  onOpenSettings(cb: () => void): () => void
  onReloadPreview(cb: () => void): () => void
  updater: {
    /** Trigger a GitHub Releases check. State is reported via onUpdaterState. */
    check(): Promise<void>
    /** Download (if needed) and apply the available update, relaunching the app. */
    install(): Promise<void>
    /** Read the current updater state synchronously. */
    state(): Promise<UpdaterState>
  }
  onUpdaterState(cb: (state: UpdaterState) => void): () => void
}

/**
 * Auto-update progress as the renderer sees it.
 * - idle: never checked yet this session
 * - checking: hitting GitHub
 * - uptodate: latest tag <= installed version
 * - available: a newer release exists but we haven't downloaded it
 * - downloading: progress is a 0..1 fraction
 * - ready: zip is on disk; clicking install will swap and relaunch
 * - error: something went wrong; user can re-check
 */
export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'uptodate' }
  | { kind: 'available'; version: string; notes: string }
  | { kind: 'downloading'; version: string; progress: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }
