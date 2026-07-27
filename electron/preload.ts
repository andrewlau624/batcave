import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type {
  BonsaiApi,
  Repo,
  Branch,
  Worktree,
  GitStatus,
  DirEntry,
  SessionOptions,
  TabState,
  LayoutState,
  AppConfig,
  SavedCommand,
  PrStatus,
  PullRequestDetail,
  PrComment,
  UpdaterState,
} from '../shared/types'

const api: BonsaiApi = {
  repos: {
    list: () => ipcRenderer.invoke('repos:list') as Promise<Repo[]>,
    add: () => ipcRenderer.invoke('repos:add') as Promise<Repo | null>,
    remove: (id) => ipcRenderer.invoke('repos:remove', id) as Promise<void>,
    reorder: (ids) => ipcRenderer.invoke('repos:reorder', ids) as Promise<Repo[]>,
    branches: (repoId) => ipcRenderer.invoke('repos:branches', repoId) as Promise<Branch[]>,
  },
  worktree: {
    ensure: (repoId, branch) =>
      ipcRenderer.invoke('worktree:ensure', repoId, branch) as Promise<Worktree>,
  },
  git: {
    status: (cwd) => ipcRenderer.invoke('git:status', cwd) as Promise<GitStatus>,
    stage: (cwd, file) => ipcRenderer.invoke('git:stage', cwd, file) as Promise<void>,
    unstage: (cwd, file) => ipcRenderer.invoke('git:unstage', cwd, file) as Promise<void>,
    stageAll: (cwd) => ipcRenderer.invoke('git:stageAll', cwd) as Promise<void>,
    commit: (cwd, message) => ipcRenderer.invoke('git:commit', cwd, message) as Promise<void>,
    push: (cwd) => ipcRenderer.invoke('git:push', cwd) as Promise<string>,
    pull: (cwd) => ipcRenderer.invoke('git:pull', cwd) as Promise<string>,
    pullAutostash: (cwd) => ipcRenderer.invoke('git:pullAutostash', cwd) as Promise<string>,
    fetch: (repoId) => ipcRenderer.invoke('git:fetch', repoId) as Promise<void>,
    checkout: (repoId, branch) =>
      ipcRenderer.invoke('git:checkout', repoId, branch) as Promise<void>,
    checkoutAutostash: (repoId, branch) =>
      ipcRenderer.invoke('git:checkoutAutostash', repoId, branch) as Promise<void>,
    inProgressOp: (repoId) =>
      ipcRenderer.invoke('git:inProgressOp', repoId) as Promise<
        import('../shared/types').InProgressOp | null
      >,
    abortInProgressOp: (repoId) =>
      ipcRenderer.invoke('git:abortInProgressOp', repoId) as Promise<void>,
    createBranch: (repoId, name, from) =>
      ipcRenderer.invoke('git:createBranch', repoId, name, from) as Promise<void>,
    deleteBranch: (repoId, name, force) =>
      ipcRenderer.invoke('git:deleteBranch', repoId, name, force) as Promise<void>,
    diffFile: (cwd, file, staged) =>
      ipcRenderer.invoke('git:diffFile', cwd, file, staged) as Promise<string>,
    readFile: (cwd, relPath) =>
      ipcRenderer.invoke('git:readFile', cwd, relPath) as Promise<{
        content: string
        truncated: boolean
      }>,
    writeFile: (cwd, relPath, content) =>
      ipcRenderer.invoke('git:writeFile', cwd, relPath, content) as Promise<void>,
    listDir: (cwd, relPath) =>
      ipcRenderer.invoke('git:listDir', cwd, relPath) as Promise<DirEntry[]>,
    log: (cwd) => ipcRenderer.invoke('git:log', cwd) as Promise<import('../shared/types').Commit[]>,
    turnSnapshot: (cwd) => ipcRenderer.invoke('git:turnSnapshot', cwd) as Promise<string>,
    turnDiff: (cwd, base, head) =>
      ipcRenderer.invoke('git:turnDiff', cwd, base, head) as Promise<string>,
    discard: (cwd, file) => ipcRenderer.invoke('git:discard', cwd, file) as Promise<void>,
    scripts: (cwd) =>
      ipcRenderer.invoke('git:scripts', cwd) as Promise<Array<{ name: string; command: string }>>,
    makeTargets: (cwd) => ipcRenderer.invoke('git:makeTargets', cwd) as Promise<string[]>,
    runnables: (cwd) =>
      ipcRenderer.invoke('git:runnables', cwd) as Promise<import('../shared/types').RunnableGroup[]>,
  },
  session: {
    create: (opts: SessionOptions) =>
      ipcRenderer.invoke('session:create', opts) as Promise<string>,
    write: (id, data) => ipcRenderer.send('session:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('session:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('session:kill', id),
    ack: (id, bytes) => ipcRenderer.send('session:ack', id, bytes),
    onData: (cb) => {
      const listener = (_e: unknown, id: string, data: string) => cb(id, data)
      ipcRenderer.on('session:data', listener)
      return () => ipcRenderer.removeListener('session:data', listener)
    },
    onExit: (cb) => {
      const listener = (_e: unknown, id: string, code: number) => cb(id, code)
      ipcRenderer.on('session:exit', listener)
      return () => ipcRenderer.removeListener('session:exit', listener)
    },
    onProcess: (cb) => {
      const listener = (_e: unknown, id: string, name: string) => cb(id, name)
      ipcRenderer.on('session:process', listener)
      return () => ipcRenderer.removeListener('session:process', listener)
    },
  },
  layout: {
    load: () =>
      ipcRenderer.invoke('layout:load') as Promise<{ tabs: TabState[]; layout: LayoutState }>,
    save: (state) => ipcRenderer.invoke('layout:save', state) as Promise<void>,
  },
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<AppConfig>,
    set: (patch) => ipcRenderer.invoke('config:set', patch) as Promise<AppConfig>,
    path: () => ipcRenderer.invoke('config:path') as Promise<string>,
    reveal: () => ipcRenderer.invoke('config:reveal') as Promise<void>,
  },
  commands: {
    list: (repoId) => ipcRenderer.invoke('commands:list', repoId) as Promise<SavedCommand[]>,
    save: (repoId, list) => ipcRenderer.invoke('commands:save', repoId, list) as Promise<void>,
  },
  usage: {
    get: (repoId) => ipcRenderer.invoke('usage:get', repoId) as Promise<Record<string, number>>,
    bump: (repoId, command) =>
      ipcRenderer.invoke('usage:bump', repoId, command) as Promise<Record<string, number>>,
  },
  branchPrefs: {
    get: (repoId) => ipcRenderer.invoke('branchPrefs:get', repoId) as Promise<string[] | null>,
    set: (repoId, names) => ipcRenderer.invoke('branchPrefs:set', repoId, names) as Promise<void>,
  },
  branchColors: {
    get: (repoId) =>
      ipcRenderer.invoke('branchColors:get', repoId) as Promise<Record<string, string>>,
    set: (repoId, map) => ipcRenderer.invoke('branchColors:set', repoId, map) as Promise<void>,
  },
  pr: {
    list: (cwd) => ipcRenderer.invoke('pr:list', cwd) as Promise<PrStatus>,
    view: (cwd, num) => ipcRenderer.invoke('pr:view', cwd, num) as Promise<PullRequestDetail>,
    comments: (cwd, num) => ipcRenderer.invoke('pr:comments', cwd, num) as Promise<PrComment[]>,
    create: (cwd, data) =>
      ipcRenderer.invoke('pr:create', cwd, data) as Promise<{ url: string }>,
    edit: (cwd, num, data) => ipcRenderer.invoke('pr:edit', cwd, num, data) as Promise<void>,
    comment: (cwd, num, body) =>
      ipcRenderer.invoke('pr:comment', cwd, num, body) as Promise<void>,
    commits: (cwd, num) =>
      ipcRenderer.invoke('pr:commits', cwd, num) as Promise<import('../shared/types').PrCommit[]>,
    commitDiff: (cwd, sha) =>
      ipcRenderer.invoke('pr:commitDiff', cwd, sha) as Promise<
        import('../shared/types').PrCommitDetail
      >,
    files: (cwd, num) =>
      ipcRenderer.invoke('pr:files', cwd, num) as Promise<import('../shared/types').PrFile[]>,
    diff: (cwd, num) => ipcRenderer.invoke('pr:diff', cwd, num) as Promise<string>,
    reviewComments: (cwd, num) =>
      ipcRenderer.invoke('pr:reviewComments', cwd, num) as Promise<
        import('../shared/types').PrReviewComment[]
      >,
    review: (cwd, num, event, body) =>
      ipcRenderer.invoke('pr:review', cwd, num, event, body) as Promise<void>,
    accounts: () => ipcRenderer.invoke('pr:accounts') as Promise<import('../shared/types').GhAccount[]>,
    switchAccount: (user) => ipcRenderer.invoke('pr:switchAccount', user) as Promise<void>,
    checkLog: (cwd, link) => ipcRenderer.invoke('pr:checkLog', cwd, link) as Promise<string>,
  },
  window: {
    openCode: (cwd, file, source) =>
      ipcRenderer.invoke('window:openCode', cwd, file, source) as Promise<void>,
    onNavigate: (cb) => {
      const listener = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload)
      ipcRenderer.on('code:navigate', listener)
      return () => ipcRenderer.removeListener('code:navigate', listener)
    },
    openPr: (cwd, num) => ipcRenderer.invoke('window:openPr', cwd, num) as Promise<void>,
    openDiff: (cwd, kind, ref, file) =>
      ipcRenderer.invoke('window:openDiff', cwd, kind, ref, file) as Promise<void>,
    openBrowser: (url) => ipcRenderer.invoke('window:openBrowser', url) as Promise<void>,
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url) as Promise<void>,
  setZoom: (factor) => webFrame.setZoomFactor(factor),
  app: {
    reveal: (p) => ipcRenderer.invoke('app:reveal', p) as Promise<void>,
    openInEditor: (p) => ipcRenderer.invoke('app:openInEditor', p) as Promise<boolean>,
    pathForFile: (file) => webUtils.getPathForFile(file),
    homeDir: () => ipcRenderer.invoke('app:homeDir') as Promise<string>,
  },
  onOpenSettings: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('menu:open-settings', listener)
    return () => ipcRenderer.removeListener('menu:open-settings', listener)
  },
  onReloadPreview: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('menu:reload-preview', listener)
    return () => ipcRenderer.removeListener('menu:reload-preview', listener)
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check') as Promise<void>,
    install: () => ipcRenderer.invoke('updater:install') as Promise<void>,
    state: () => ipcRenderer.invoke('updater:state') as Promise<UpdaterState>,
  },
  onUpdaterState: (cb) => {
    const listener = (_e: unknown, state: UpdaterState) => cb(state)
    ipcRenderer.on('updater:state', listener)
    return () => ipcRenderer.removeListener('updater:state', listener)
  },
}

contextBridge.exposeInMainWorld('bonsai', api)
