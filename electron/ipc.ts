import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  Repo,
  SessionOptions,
  TabState,
  LayoutState,
  AppConfig,
  SavedCommand,
  CodeDiffSource,
} from '../shared/types'
import * as gitOps from './git'
import * as ptyMgr from './pty'
import * as store from './store'
import * as github from './github'
import * as updater from './updater'
import { openCodeWindow, openPrWindow, openDiffWindow, openBrowserWindow } from './main'

export function registerIpc(): void {
  // ---- Repos ----
  ipcMain.handle('repos:list', () => store.getRepos())

  ipcMain.handle('repos:add', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Add a git repository',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const repoPath = result.filePaths[0]
    if (!(await gitOps.isGitRepo(repoPath))) {
      await dialog.showMessageBox(win, {
        type: 'error',
        message: 'Not a git repository',
        detail: `${repoPath} is not a git repository.`,
      })
      return null
    }

    const repos = store.getRepos()
    const existing = repos.find((r) => path.resolve(r.path) === path.resolve(repoPath))
    if (existing) return existing

    const repo: Repo = { id: randomUUID(), name: path.basename(repoPath), path: repoPath }
    store.setRepos([...repos, repo])
    return repo
  })

  ipcMain.handle('repos:remove', (_e, id: string) => {
    store.setRepos(store.getRepos().filter((r) => r.id !== id))
  })

  ipcMain.handle('repos:reorder', (_e, orderedIds: string[]) => {
    const current = store.getRepos()
    const byId = new Map(current.map((r) => [r.id, r]))
    const reordered: Repo[] = []
    for (const id of orderedIds) {
      const r = byId.get(id)
      if (r) {
        reordered.push(r)
        byId.delete(id)
      }
    }
    // Append any repos missing from the ordered list so we never lose one.
    for (const r of byId.values()) reordered.push(r)
    store.setRepos(reordered)
    return reordered
  })

  ipcMain.handle('repos:branches', async (_e, repoId: string) => {
    const repo = store.getRepos().find((r) => r.id === repoId)
    if (!repo) return []
    return gitOps.listBranches(repo.path)
  })

  // ---- Worktrees ----
  ipcMain.handle('worktree:ensure', async (_e, repoId: string, branch: string) => {
    const repo = store.getRepos().find((r) => r.id === repoId)
    if (!repo) throw new Error('Unknown repo')
    const carryEnv = store.getConfig().modes.autoCarryEnv !== false
    const wt = await gitOps.ensureWorktree(repo.path, repo.name, branch, carryEnv)
    return { ...wt, repoId }
  })

  // ---- Git working tree + branch management ----
  const repoPath = (repoId: string): string => {
    const repo = store.getRepos().find((r) => r.id === repoId)
    if (!repo) throw new Error('Unknown repo')
    return repo.path
  }

  ipcMain.handle('git:status', (_e, cwd: string) => gitOps.status(cwd))
  ipcMain.handle('git:stage', (_e, cwd: string, file: string) => gitOps.stageFile(cwd, file))
  ipcMain.handle('git:unstage', (_e, cwd: string, file: string) => gitOps.unstageFile(cwd, file))
  ipcMain.handle('git:stageAll', (_e, cwd: string) => gitOps.stageAll(cwd))
  ipcMain.handle('git:commit', (_e, cwd: string, message: string) => gitOps.commit(cwd, message))
  ipcMain.handle('git:push', (_e, cwd: string) => gitOps.push(cwd))
  ipcMain.handle('git:pull', (_e, cwd: string) => gitOps.pull(cwd))
  ipcMain.handle('git:pullAutostash', (_e, cwd: string) => gitOps.pullAutostash(cwd))
  ipcMain.handle('git:fetch', (_e, repoId: string) => gitOps.fetch(repoPath(repoId)))
  ipcMain.handle('git:checkout', (_e, repoId: string, branch: string) =>
    gitOps.checkout(repoPath(repoId), branch),
  )
  ipcMain.handle('git:checkoutAutostash', (_e, repoId: string, branch: string) =>
    gitOps.checkoutAutostash(repoPath(repoId), branch),
  )
  ipcMain.handle('git:inProgressOp', (_e, repoId: string) =>
    gitOps.inProgressOperation(repoPath(repoId)),
  )
  ipcMain.handle('git:abortInProgressOp', (_e, repoId: string) =>
    gitOps.abortInProgressOperation(repoPath(repoId)),
  )
  ipcMain.handle('git:createBranch', (_e, repoId: string, name: string, from?: string) =>
    gitOps.createBranch(repoPath(repoId), name, from),
  )
  ipcMain.handle('git:deleteBranch', (_e, repoId: string, name: string, force?: boolean) =>
    gitOps.deleteBranch(repoPath(repoId), name, force),
  )
  ipcMain.handle('git:diffFile', (_e, cwd: string, file: string, staged: boolean) =>
    gitOps.diffFile(cwd, file, staged),
  )
  ipcMain.handle('git:readFile', (_e, cwd: string, relPath: string) =>
    gitOps.readFile(cwd, relPath),
  )
  ipcMain.handle('git:writeFile', (_e, cwd: string, relPath: string, content: string) =>
    gitOps.writeFile(cwd, relPath, content),
  )
  ipcMain.handle('git:listDir', (_e, cwd: string, relPath: string) =>
    gitOps.listDir(cwd, relPath),
  )
  ipcMain.handle('git:log', (_e, cwd: string) => gitOps.log(cwd))
  ipcMain.handle('git:turnSnapshot', (_e, cwd: string) => gitOps.turnSnapshot(cwd))
  ipcMain.handle('git:turnDiff', (_e, cwd: string, base: string, head: string) =>
    gitOps.turnDiff(cwd, base, head),
  )
  ipcMain.handle('git:discard', (_e, cwd: string, file: string) => gitOps.discardFile(cwd, file))
  ipcMain.handle('git:scripts', (_e, cwd: string) => gitOps.packageScripts(cwd))
  ipcMain.handle('git:makeTargets', (_e, cwd: string) => gitOps.makeTargets(cwd))
  ipcMain.handle('git:runnables', (_e, cwd: string) => gitOps.detectRunnables(cwd))

  // ---- Sessions (PTY) ----
  ipcMain.handle('session:create', (event, opts: SessionOptions) =>
    ptyMgr.createSession(opts, event.sender),
  )
  ipcMain.on('session:write', (_e, id: string, data: string) => ptyMgr.writeSession(id, data))
  ipcMain.on('session:resize', (_e, id: string, cols: number, rows: number) =>
    ptyMgr.resizeSession(id, cols, rows),
  )
  ipcMain.on('session:kill', (_e, id: string) => ptyMgr.killSession(id))

  // ---- Layout persistence ----
  ipcMain.handle('layout:load', () => store.getLayout())
  ipcMain.handle('layout:save', (_e, state: { tabs: TabState[]; layout: LayoutState }) =>
    store.setLayout(state),
  )

  // ---- Config ----
  ipcMain.handle('config:get', () => store.getConfig())
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => store.setConfig(patch))
  ipcMain.handle('config:path', () => store.configPath())
  ipcMain.handle('config:reveal', () => shell.showItemInFolder(store.configPath()))

  // ---- Saved commands ----
  ipcMain.handle('commands:list', (_e, repoId: string) => store.getCommands(repoId))
  ipcMain.handle('commands:save', (_e, repoId: string, list: SavedCommand[]) =>
    store.setCommands(repoId, list),
  )
  ipcMain.handle('branchPrefs:get', (_e, repoId: string) => store.getBranchPrefs(repoId))
  ipcMain.handle('branchPrefs:set', (_e, repoId: string, names: string[]) =>
    store.setBranchPrefs(repoId, names),
  )
  ipcMain.handle('branchColors:get', (_e, repoId: string) => store.getBranchColors(repoId))
  ipcMain.handle('branchColors:set', (_e, repoId: string, map: Record<string, string>) =>
    store.setBranchColors(repoId, map),
  )
  ipcMain.handle('usage:get', (_e, repoId: string) => store.getUsage(repoId))
  ipcMain.handle('usage:bump', (_e, repoId: string, command: string) =>
    store.bumpUsage(repoId, command),
  )

  // ---- Code viewer window ----
  ipcMain.handle('window:openCode', (_e, cwd: string, file: string, source?: CodeDiffSource) =>
    openCodeWindow(cwd, file, source),
  )
  ipcMain.handle('window:openPr', (_e, cwd: string, num: number) => openPrWindow(cwd, num))
  ipcMain.handle('window:openDiff', (_e, cwd: string, kind: string, ref: string, file: string) =>
    openDiffWindow(cwd, kind, ref, file),
  )
  ipcMain.handle('window:openBrowser', (_e, url: string) => openBrowserWindow(url))
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('app:reveal', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('app:homeDir', () => os.homedir())
  ipcMain.handle('app:openInEditor', async (_e, p: string) => {
    for (const ed of ['code', 'cursor', 'subl', 'zed', 'webstorm']) {
      const ok = await new Promise<boolean>((resolve) => {
        try {
          const cp = spawn(ed, [p], { detached: true, stdio: 'ignore' })
          cp.on('error', () => resolve(false))
          cp.on('spawn', () => {
            cp.unref()
            resolve(true)
          })
        } catch {
          resolve(false)
        }
      })
      if (ok) return true
    }
    await shell.openPath(p)
    return false
  })

  // ---- Pull requests (gh) ----
  ipcMain.handle('pr:list', (_e, cwd: string) => github.prList(cwd))
  ipcMain.handle('pr:view', (_e, cwd: string, num: number) => github.prView(cwd, num))
  ipcMain.handle(
    'pr:create',
    (_e, cwd: string, data: { title: string; body: string; base?: string; draft?: boolean }) =>
      github.prCreate(cwd, data),
  )
  ipcMain.handle('pr:edit', (_e, cwd: string, num: number, data: { title: string; body: string }) =>
    github.prEdit(cwd, num, data),
  )
  ipcMain.handle('pr:comments', (_e, cwd: string, num: number) => github.prComments(cwd, num))
  ipcMain.handle('pr:comment', (_e, cwd: string, num: number, body: string) =>
    github.prComment(cwd, num, body),
  )
  ipcMain.handle(
    'pr:review',
    (_e, cwd: string, num: number, event: 'approve' | 'request-changes' | 'comment', body: string) =>
      github.prReview(cwd, num, event, body),
  )
  ipcMain.handle('pr:commits', (_e, cwd: string, num: number) => github.prCommits(cwd, num))
  ipcMain.handle('pr:commitDiff', (_e, cwd: string, sha: string) => github.prCommitDiff(cwd, sha))
  ipcMain.handle('pr:files', (_e, cwd: string, num: number) => github.prFiles(cwd, num))
  ipcMain.handle('pr:diff', (_e, cwd: string, num: number) => github.prDiff(cwd, num))
  ipcMain.handle('pr:reviewComments', (_e, cwd: string, num: number) =>
    github.prReviewComments(cwd, num),
  )
  ipcMain.handle('pr:accounts', () => github.ghAccounts())
  ipcMain.handle('pr:switchAccount', (_e, user: string) => github.ghSwitch(user))
  ipcMain.handle('pr:checkLog', (_e, cwd: string, link: string) => github.checkLog(cwd, link))

  // ---- Auto-updater (GitHub Releases, unsigned mac swap-in-place) ----
  ipcMain.handle('updater:check', () => updater.checkForUpdates())
  ipcMain.handle('updater:install', () => updater.installUpdate())
  ipcMain.handle('updater:state', () => updater.getState())
}
