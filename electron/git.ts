import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { simpleGit, SimpleGit } from 'simple-git'
import type { Branch, Worktree, GitStatus, FileChange, DirEntry, Commit } from '../shared/types'
import { carryEnvFiles } from './env-vault'

// Worktrees are stored centrally so they don't clutter the repo's parent dir:
//   ~/.bonsai/worktrees/<repoName>/<sanitized-branch>
const WORKTREES_ROOT = path.join(os.homedir(), '.bonsai', 'worktrees')

function git(repoPath: string): SimpleGit {
  return simpleGit({ baseDir: repoPath })
}

function sanitizeBranch(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    return await git(repoPath).checkIsRepo()
  } catch {
    return false
  }
}

export async function currentBranch(repoPath: string): Promise<string> {
  const name = (await git(repoPath).revparse(['--abbrev-ref', 'HEAD'])).trim()
  return name === 'HEAD' ? '(detached)' : name
}

/**
 * Marker prefix on errors thrown from `checkout()` when the primary checkout is
 * mid-rebase. The renderer keys off this to offer a one-click "abort + retry".
 */
export const REBASE_IN_PROGRESS_MARKER = '__BONSAI_REBASE_IN_PROGRESS__'

/**
 * Thrown by `pull()` when git refuses to update the working tree because local
 * changes or untracked files would be clobbered. The renderer keys off this to
 * offer a one-click "stash + pull + re-apply" instead of dumping git's (very
 * long) raw refusal into an alert.
 */
export const PULL_DIRTY_TREE_MARKER = '__BONSAI_PULL_DIRTY_TREE__'

/**
 * Thrown by `pullAutostash()` when the pull succeeded but re-applying the
 * stashed local changes hit a conflict. The changes are preserved in the stash;
 * the renderer tells the user to resolve them in their editor.
 */
export const PULL_AUTOSTASH_CONFLICT_MARKER = '__BONSAI_PULL_AUTOSTASH_CONFLICT__'

/**
 * Detect whether `repoPath`'s primary checkout is currently mid-rebase. Works
 * for both the `apply` (am) and `merge` (interactive) backends.
 */
export function isRebaseInProgress(repoPath: string): boolean {
  const gitDir = path.join(repoPath, '.git')
  // In primary checkouts `.git` is a dir; in linked worktrees it's a file
  // pointing at the real gitdir. The primary repoPath we get here is always a
  // real checkout, so the simple form is enough.
  return (
    fs.existsSync(path.join(gitDir, 'rebase-merge')) ||
    fs.existsSync(path.join(gitDir, 'rebase-apply'))
  )
}

/** Abort an in-progress rebase, restoring the original HEAD. */
export async function rebaseAbort(repoPath: string): Promise<void> {
  await git(repoPath).raw(['rebase', '--abort'])
}

interface RawWorktree {
  path: string
  branch: string | null
}

/** Parse `git worktree list --porcelain` into structured entries. */
async function listWorktrees(repoPath: string): Promise<RawWorktree[]> {
  const out = await git(repoPath).raw(['worktree', 'list', '--porcelain'])
  const trees: RawWorktree[] = []
  let cur: Partial<RawWorktree> = {}
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? null })
      cur = { path: line.slice('worktree '.length).trim() }
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace('refs/heads/', '').trim()
    } else if (line === '') {
      if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? null })
      cur = {}
    }
  }
  if (cur.path) trees.push({ path: cur.path, branch: cur.branch ?? null })
  return trees
}

export async function listBranches(repoPath: string): Promise<Branch[]> {
  const g = git(repoPath)
  const summary = await g.branchLocal()
  const worktrees = await listWorktrees(repoPath)
  const byBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w.path]))

  // During a rebase / detached HEAD, `git branch` emits a pseudo-entry like
  // `(no branch, rebasing main)`. Don't surface it as a switchable branch.
  return summary.all
    .filter((name) => !name.startsWith('('))
    .map((name) => ({
      name,
      current: name === summary.current,
      worktreePath: byBranch.get(name) ?? null,
    }))
}

/**
 * Ensure a usable worktree exists for `branch`, creating one if needed, then
 * carry the primary checkout's `.env*` files into it.
 */
export async function ensureWorktree(
  repoPath: string,
  repoName: string,
  branch: string,
  carryEnv = true,
): Promise<Worktree> {
  // Defensive guard: pseudo-branches like `(no branch, rebasing main)` are not
  // valid refs. Filtering happens upstream in listBranches(), but a stale
  // persisted tab could still reach here.
  if (branch.startsWith('(')) {
    throw new Error(
      `"${branch}" isn't a real branch — it's a transient git state. ` +
        `Finish or abort any in-progress rebase, then try again.`,
    )
  }
  const g = git(repoPath)
  const cur = await currentBranch(repoPath)

  if (branch === cur) {
    return {
      repoId: '',
      branch,
      path: repoPath,
      primary: true,
      carriedEnvFiles: carryEnv ? carryEnvFiles(repoPath, repoPath) : [],
    }
  }

  const existing = (await listWorktrees(repoPath)).find((w) => w.branch === branch)
  let worktreePath = existing?.path

  if (!worktreePath) {
    const dir = path.join(WORKTREES_ROOT, sanitizeBranch(repoName), sanitizeBranch(branch))
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    worktreePath = await addWorktreeResilient(g, repoPath, dir, branch)
  }

  const carriedEnvFiles = carryEnv ? carryEnvFiles(repoPath, worktreePath) : []
  return { repoId: '', branch, path: worktreePath, primary: false, carriedEnvFiles }
}

/** A linked worktree keeps a `.git` *file* (not a directory) at its root. */
function isLinkedWorktree(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isFile()
  } catch {
    return false
  }
}

/**
 * `git worktree add`, but resilient to a stale leftover directory already
 * sitting at `dir`. This is the root cause of the recurring
 * "fatal: '…' already exists" error: a worktree dir survives without a live
 * registration (after a crash, a half-finished `worktree remove`, or branch
 * drift), and a plain add then refuses.
 *
 * Recovery order, all non-destructive to committed/uncommitted work:
 *   1. prune dead registrations, then reuse any live worktree for this branch/path
 *   2. repair + reuse a detached-but-valid linked worktree at `dir`
 *   3. remove a clearly-empty orphan folder and retry the add
 *   4. otherwise surface a clear, actionable error (never raw git output)
 */
async function addWorktreeResilient(
  g: SimpleGit,
  repoPath: string,
  dir: string,
  branch: string,
): Promise<string> {
  try {
    await g.raw(['worktree', 'add', dir, branch])
    return dir
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/already exists/i.test(msg)) throw err

    // (1) Clear registrations whose dirs are gone, then see whether a live
    // worktree for this branch — or at this exact path — surfaced.
    await g.raw(['worktree', 'prune']).catch(() => {})
    let trees = await listWorktrees(repoPath)
    const forBranch = trees.find((w) => w.branch === branch)
    if (forBranch) return forBranch.path
    const atPath = trees.find((w) => path.resolve(w.path) === path.resolve(dir))
    if (atPath) return atPath.path

    // The dir vanished during prune — retry a clean add.
    if (!fs.existsSync(dir)) {
      await g.raw(['worktree', 'add', dir, branch])
      return dir
    }

    // (2) A valid linked worktree is sitting there unregistered — re-link it.
    if (isLinkedWorktree(dir)) {
      await g.raw(['worktree', 'repair', dir]).catch(() => {})
      trees = await listWorktrees(repoPath)
      const repaired = trees.find((w) => path.resolve(w.path) === path.resolve(dir))
      if (repaired) return repaired.path
    }

    // (3) An orphan folder with no git linkage. Remove it only when empty so we
    // never discard files that git isn't tracking, then retry.
    let empty = false
    try {
      empty = fs.readdirSync(dir).length === 0
    } catch {
      /* unreadable — treat as non-empty and bail to the safe error below */
    }
    if (empty) {
      fs.rmSync(dir, { recursive: true, force: true })
      await g.raw(['worktree', 'add', dir, branch])
      return dir
    }

    // (4) Can't safely reclaim it — tell the user exactly what to do.
    throw new Error(
      `A leftover folder is blocking the worktree for "${branch}":\n${dir}\n\n` +
        `It isn't a tracked git worktree and isn't empty, so Bonsai won't delete it ` +
        `automatically. Move or remove that folder, then try again.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Branch management
// ---------------------------------------------------------------------------

export async function createBranch(repoPath: string, name: string, from?: string): Promise<void> {
  const clean = name.trim()
  if (!clean) throw new Error('Branch name is required')
  // Let git validate the ref name; it rejects spaces, ~, ^, etc.
  const args = from ? ['branch', clean, from] : ['branch', clean]
  await git(repoPath).raw(args)
}

export async function deleteBranch(
  repoPath: string,
  name: string,
  force = false,
): Promise<void> {
  // A branch checked out in a worktree can't be deleted until the worktree goes.
  const wt = (await listWorktrees(repoPath)).find((w) => w.branch === name)
  if (wt && path.resolve(wt.path) !== path.resolve(repoPath)) {
    await git(repoPath).raw(['worktree', 'remove', '--force', wt.path])
  }
  await git(repoPath).raw(['branch', force ? '-D' : '-d', name])
}

export async function fetch(repoPath: string): Promise<void> {
  await git(repoPath).raw(['fetch', '--all', '--prune'])
}

/**
 * Switch the primary checkout's HEAD to `branch`. If `branch` is currently held
 * by a managed worktree, that worktree is removed first (git forbids the same
 * branch checked out in two places) — but only when it's clean, so uncommitted
 * work is never silently discarded.
 */
export async function checkout(repoPath: string, branch: string): Promise<void> {
  const g = git(repoPath)

  // Mid-rebase, `git switch` refuses with a fatal error. Surface a structured
  // marker so the renderer can offer a one-click "abort and retry" affordance.
  if (isRebaseInProgress(repoPath)) {
    throw new Error(`${REBASE_IN_PROGRESS_MARKER}:${branch}`)
  }

  const heldElsewhere = async () => {
    const wt = (await listWorktrees(repoPath)).find((w) => w.branch === branch)
    return wt && path.resolve(wt.path) !== path.resolve(repoPath) ? wt : null
  }

  const wt = await heldElsewhere()
  if (wt) {
    try {
      await g.raw(['worktree', 'remove', wt.path])
    } catch {
      // The dir may have been deleted manually (stale registration) — prune and
      // see if that cleared it. If a real, dirty worktree still holds the
      // branch, stop rather than risk discarding uncommitted work.
      await g.raw(['worktree', 'prune'])
      if (await heldElsewhere()) {
        throw new Error(
          `"${branch}" is open in a worktree with uncommitted changes.\n` +
            `Commit or stash them in that terminal first, then try again.`,
        )
      }
    }
  }
  await g.raw(['switch', branch])
}

// ---------------------------------------------------------------------------
// Working tree: status, staging, commit, sync
// ---------------------------------------------------------------------------

function classify(index: string, working: string): FileChange['status'] {
  if (index === '?' && working === '?') return 'untracked'
  if (index === 'U' || working === 'U') return 'conflicted'
  const c = index !== ' ' && index !== '?' ? index : working
  switch (c) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return 'modified'
  }
}

export async function status(cwd: string): Promise<GitStatus> {
  const g = git(cwd)
  const s = await g.status()

  // Per-file insertion/deletion counts for tracked changes (vs HEAD).
  const stats = new Map<string, { insertions: number; deletions: number }>()
  try {
    const summary = await g.diffSummary(['HEAD'])
    for (const f of summary.files) {
      if (!('binary' in f) || !f.binary) {
        const tf = f as { file: string; insertions: number; deletions: number }
        stats.set(tf.file, { insertions: tf.insertions, deletions: tf.deletions })
      }
    }
  } catch {
    /* no commits yet, or detached — counts just stay undefined */
  }

  const files: FileChange[] = s.files.map((f) => {
    const st = stats.get(f.path)
    return {
      path: f.path,
      index: f.index,
      working: f.working_dir,
      status: classify(f.index, f.working_dir),
      staged: f.index !== ' ' && f.index !== '?',
      unstaged: f.working_dir !== ' ',
      insertions: st?.insertions,
      deletions: st?.deletions,
    }
  })

  return {
    branch: s.current ?? '(detached)',
    tracking: s.tracking ?? null,
    ahead: s.ahead,
    behind: s.behind,
    files,
    clean: files.length === 0,
  }
}

export async function stageFile(cwd: string, file: string): Promise<void> {
  await git(cwd).add([file])
}

export async function stageAll(cwd: string): Promise<void> {
  await git(cwd).add(['-A'])
}

export async function unstageFile(cwd: string, file: string): Promise<void> {
  try {
    await git(cwd).raw(['restore', '--staged', '--', file])
  } catch {
    // Repo with no commits yet: fall back to plain reset.
    await git(cwd).raw(['reset', '--', file])
  }
}

export async function discardFile(cwd: string, file: string): Promise<void> {
  try {
    await git(cwd).raw(['restore', '--staged', '--worktree', '--', file])
  } catch {
    // Untracked (or no HEAD yet) — just remove the file.
    try {
      fs.rmSync(path.resolve(cwd, file), { force: true })
    } catch {
      /* ignore */
    }
  }
}

/** package.json scripts in the worktree, for one-click running. */
export function packageScripts(cwd: string): Array<{ name: string; command: string }> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    return Object.entries(pkg.scripts ?? {}).map(([name, command]) => ({ name, command }))
  } catch {
    return []
  }
}

export interface RunnableGroup {
  source: string
  kind: 'npm' | 'make' | 'md'
  items: Array<{ label: string; command: string }>
}

const CMD_PREFIXES =
  /^(npm|npx|pnpm|yarn|bun|deno|node|make|git|docker|docker-compose|supabase|python3?|pip3?|cargo|go|rails|rake|bundle|flask|django|php|composer|kubectl|terraform|vercel|netlify|fly|wrangler|\.\/|sh |bash )/

/** Extract shell commands from fenced code blocks in markdown. */
function commandsFromMarkdown(md: string): string[] {
  const out: string[] = []
  const fence = /```([a-zA-Z]*)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(md))) {
    const lang = m[1].toLowerCase()
    const shellish = ['', 'sh', 'bash', 'shell', 'zsh', 'console', 'shellsession'].includes(lang)
    if (!shellish) continue
    for (let line of m[2].split('\n')) {
      line = line.trim().replace(/^[$#]\s+/, '')
      if (!line || line.startsWith('#') || line.length > 200) continue
      // For unlabelled blocks, only keep lines that clearly look like commands.
      if (lang === '' && !CMD_PREFIXES.test(line)) continue
      out.push(line)
    }
  }
  return [...new Set(out)]
}

/** Everything runnable in the worktree: npm scripts, make targets, and shell
 * commands pulled from README/markdown files — grouped by source. */
export function detectRunnables(cwd: string): RunnableGroup[] {
  const groups: RunnableGroup[] = []

  const npm = packageScripts(cwd)
  if (npm.length) {
    groups.push({
      source: 'package.json',
      kind: 'npm',
      items: npm.map((s) => ({ label: s.name, command: `npm run ${s.name}` })),
    })
  }

  const make = makeTargets(cwd)
  if (make.length) {
    groups.push({
      source: 'Makefile',
      kind: 'make',
      items: make.map((t) => ({ label: t, command: `make ${t}` })),
    })
  }

  // Markdown: root *.md plus one level of docs/, capped.
  const mdFiles: string[] = []
  try {
    for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (e.isFile() && /\.md$/i.test(e.name)) mdFiles.push(e.name)
      else if (e.isDirectory() && /^(docs?|documentation)$/i.test(e.name)) {
        try {
          for (const f of fs.readdirSync(path.join(cwd, e.name)))
            if (/\.md$/i.test(f)) mdFiles.push(path.join(e.name, f))
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  for (const rel of mdFiles.slice(0, 15)) {
    let txt: string
    try {
      txt = fs.readFileSync(path.join(cwd, rel), 'utf8')
    } catch {
      continue
    }
    const cmds = commandsFromMarkdown(txt)
    if (cmds.length) {
      groups.push({
        source: rel,
        kind: 'md',
        items: cmds.map((c) => ({ label: c, command: c })),
      })
    }
  }

  return groups
}

/** Makefile targets in the worktree (for `make <target>`). */
export function makeTargets(cwd: string): string[] {
  for (const file of ['Makefile', 'makefile', 'GNUmakefile']) {
    let txt: string
    try {
      txt = fs.readFileSync(path.join(cwd, file), 'utf8')
    } catch {
      continue
    }
    const targets: string[] = []
    for (const line of txt.split('\n')) {
      // A target line: name: ... at column 0, not a variable assignment.
      const m = /^([a-zA-Z0-9][a-zA-Z0-9_.\-/]*)\s*:(?!=)/.exec(line)
      if (m && m[1] !== '.PHONY' && !m[1].includes('/')) targets.push(m[1])
    }
    return [...new Set(targets)]
  }
  return []
}

export async function commit(cwd: string, message: string): Promise<void> {
  const msg = message.trim()
  if (!msg) throw new Error('Commit message is required')
  await git(cwd).commit(msg)
}

export async function push(cwd: string): Promise<string> {
  const s = await git(cwd).status()
  if (!s.tracking) {
    const r = await git(cwd).raw(['push', '-u', 'origin', s.current ?? 'HEAD'])
    return r
  }
  return git(cwd).raw(['push'])
}

/** Git's working-tree-would-be-clobbered refusals, all of which a stash fixes. */
function isDirtyTreePullError(message: string): boolean {
  return /would be overwritten|commit your changes or stash|cannot fast-forward your working tree/i.test(
    message,
  )
}

export async function pull(cwd: string): Promise<string> {
  try {
    return await git(cwd).raw(['pull'])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isDirtyTreePullError(msg)) throw new Error(PULL_DIRTY_TREE_MARKER)
    throw err
  }
}

/**
 * Stash everything (including untracked files), pull, then re-apply the stash.
 * Used after `pull()` reports a dirty tree. The stash keeps the user's work
 * safe: if re-applying conflicts, git leaves the stash in place and we throw
 * PULL_AUTOSTASH_CONFLICT_MARKER so the renderer can explain.
 */
export async function pullAutostash(cwd: string): Promise<string> {
  const g = git(cwd)
  await g.raw(['stash', 'push', '--include-untracked', '-m', 'bonsai: auto-stash before pull'])
  let pullOut: string
  try {
    pullOut = await g.raw(['pull'])
  } catch (err) {
    // Pull failed for some other reason — undo the stash so the tree is restored.
    await g.raw(['stash', 'pop']).catch(() => {})
    throw err
  }
  try {
    const popOut = await g.raw(['stash', 'pop'])
    return `${pullOut}\n${popOut}`.trim()
  } catch {
    throw new Error(PULL_AUTOSTASH_CONFLICT_MARKER)
  }
}

// ---------------------------------------------------------------------------
// Diff + file/directory inspection
// ---------------------------------------------------------------------------

export async function diffFile(cwd: string, file: string, staged: boolean): Promise<string> {
  const g = git(cwd)
  if (staged) return g.diff(['--cached', '--', file])

  const out = await g.raw(['diff', '--', file])
  if (out.trim()) return out

  // Untracked (or otherwise no tracked diff): synthesize an all-additions diff
  // straight from the file so the viewer always shows something useful.
  try {
    const abs = path.resolve(cwd, file)
    const raw = fs.readFileSync(abs, 'utf8')
    const lines = raw.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const header = `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`
    return header + lines.map((l) => `+${l}`).join('\n')
  } catch {
    return out
  }
}

// ---- Turn snapshots ----
// Take a snapshot of the working tree (including untracked files) without
// changing the index, working tree, refs, or stash list. `git stash create -u`
// returns the SHA of a freshly written commit object that captures everything;
// it's dangling, so git GC will eventually clean it up if we stop referencing it.
// Returns '' when there is nothing to snapshot (clean tree).
export async function turnSnapshot(cwd: string): Promise<string> {
  try {
    const sha = (await git(cwd).raw(['stash', 'create', '-u'])).trim()
    return sha
  } catch {
    return ''
  }
}

// Diff between two refs (or one ref vs HEAD when head is missing). If a ref is
// empty (clean tree at that endpoint), substitute HEAD on that side so the diff
// still makes sense.
export async function turnDiff(
  cwd: string,
  baseRef: string,
  headRef: string,
): Promise<string> {
  const g = git(cwd)
  const base = baseRef || 'HEAD'
  const head = headRef || 'HEAD'
  if (base === head) return ''
  try {
    return await g.raw(['diff', base, head])
  } catch {
    return ''
  }
}

// Write a UTF-8 file inside a worktree. Path is constrained to the worktree
// so an editor save can't escape via "../" or absolute paths.
export function writeFile(cwd: string, relPath: string, content: string): void {
  const abs = path.resolve(cwd, relPath)
  if (!abs.startsWith(path.resolve(cwd))) throw new Error('Path escapes worktree')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

const MAX_FILE_BYTES = 2 * 1024 * 1024

export function readFile(cwd: string, relPath: string): { content: string; truncated: boolean } {
  const abs = path.resolve(cwd, relPath)
  if (!abs.startsWith(path.resolve(cwd))) throw new Error('Path escapes worktree')
  const stat = fs.statSync(abs)
  if (stat.size > MAX_FILE_BYTES) {
    const fd = fs.openSync(abs, 'r')
    const buf = Buffer.alloc(MAX_FILE_BYTES)
    fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0)
    fs.closeSync(fd)
    return { content: buf.toString('utf8'), truncated: true }
  }
  return { content: fs.readFileSync(abs, 'utf8'), truncated: false }
}

export async function log(cwd: string): Promise<Commit[]> {
  // Use a unit separator so subjects with any punctuation parse cleanly.
  const fmt = '%H%x1f%h%x1f%s%x1f%an%x1f%cr'
  const out = await git(cwd).raw(['log', '-n', '50', `--pretty=format:${fmt}`])
  if (!out.trim()) return []
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, subject, author, relative] = line.split('\x1f')
      return { hash, shortHash, subject, author, relative }
    })
}

export function listDir(cwd: string, relPath: string): DirEntry[] {
  const abs = path.resolve(cwd, relPath || '.')
  if (!abs.startsWith(path.resolve(cwd))) throw new Error('Path escapes worktree')
  const entries = fs.readdirSync(abs, { withFileTypes: true })
  return entries
    .filter((e) => e.name !== '.git')
    .map((e) => ({
      name: e.name,
      type: e.isDirectory() ? ('dir' as const) : ('file' as const),
      path: path.join(relPath || '', e.name),
    }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}
