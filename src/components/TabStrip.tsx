import { useEffect, useRef, useState } from 'react'
import type { TabState } from '../../shared/types'
import { useApp, tabDisplayName, tabBusy, LOCAL_REPO_ID } from '../store'
import { Icon } from './Icon'
import { previewLabel } from './PortsMenu'
import { resolveBranchColor } from '../colors'

/**
 * Single-row collapsible tab strip: repo > branch > terminal.
 *
 * - Repos render as pills. Only the active repo expands inline; siblings stay
 *   collapsed pills showing `name · count`. Click a sibling pill to focus it.
 * - Inside the active repo, branches behave the same way: only the active
 *   branch's terminals are visible; sibling branches collapse to `name · count`.
 * - The synthetic '__local__' repo has no branches — its terminals render as
 *   flat chips directly under the repo group.
 *
 * The visual hierarchy is intentionally three tiers so the user can always
 * answer "which repo am I in, which branch, which terminal" at a glance.
 */
export function TabStrip() {
  const tabs = useApp((s) => s.tabs)
  const activeTabId = useApp((s) => s.activeTabId)
  const activeRepoId = useApp((s) => s.activeRepoId)
  const repos = useApp((s) => s.repos)
  const processByTab = useApp((s) => s.processByTab)
  const branchesByRepo = useApp((s) => s.branchesByRepo)
  const branchColorsByRepo = useApp((s) => s.branchColorsByRepo)
  const setActiveTab = useApp((s) => s.setActiveTab)
  const setActiveRepo = useApp((s) => s.setActiveRepo)
  const reorderRepos = useApp((s) => s.reorderRepos)
  const closeTab = useApp((s) => s.closeTab)
  const togglePinTab = useApp((s) => s.togglePinTab)
  const reorderTabs = useApp((s) => s.reorderTabs)
  const newTabOnActive = useApp((s) => s.newTabOnActive)
  const openLocalTerminal = useApp((s) => s.openLocalTerminal)
  const previewTabs = useApp((s) => s.previewTabs)
  const activePane = useApp((s) => s.activePane)
  const setPaneActive = useApp((s) => s.setPaneActive)
  const closePreviewTab = useApp((s) => s.closePreviewTab)

  const dragId = useRef<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const repoDragId = useRef<string | null>(null)
  const [repoDropId, setRepoDropId] = useState<string | null>(null)
  // Manual overrides for branch-group expansion. Auto-collapse means the active
  // branch is open by default; users can flip a sibling open and we remember it
  // until the active branch changes.
  const [expandedOverride, setExpandedOverride] = useState<Set<string>>(new Set())
  // Ports start collapsed so they don't crowd the branch row; expanded on click
  // (and always while a port pane is the active view, so it stays reachable).
  const [portsExpanded, setPortsExpanded] = useState(false)
  const lastTabByRepo = useRef<Record<string, string>>({})
  const lastTabByBranch = useRef<Record<string, string>>({})

  // Track most-recent tab per repo/branch so collapsed pills can restore focus.
  const activeTab = tabs.find((t) => t.id === activeTabId)
  useEffect(() => {
    if (activeTab) {
      lastTabByRepo.current[activeTab.repoId] = activeTab.id
      lastTabByBranch.current[`${activeTab.repoId}::${activeTab.branch}`] = activeTab.id
      // Auto-expand the active branch when it changes. The user can collapse it
      // afterward; this only seeds the initial open state on activation.
      const key = `${activeTab.repoId}::${activeTab.branch}`
      setExpandedOverride((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    }
  }, [activeTab?.id])

  // Repo order in the strip = canonical `repos[]` order (user-draggable),
  // restricted to repos that either have tabs or are the active repo, then
  // '__local__' pinned to the end (always present as an entry point).
  const repoOrder: string[] = []
  for (const r of repos) {
    if (r.id === LOCAL_REPO_ID) continue
    if (tabs.some((t) => t.repoId === r.id) || r.id === activeRepoId) repoOrder.push(r.id)
  }
  repoOrder.push(LOCAL_REPO_ID)

  if (tabs.length === 0 && !activeRepoId) return null

  const repoName = (id: string) =>
    id === LOCAL_REPO_ID ? 'Local' : repos.find((r) => r.id === id)?.name ?? '?'
  const repoCount = (id: string) => tabs.filter((t) => t.repoId === id).length

  // ---- drag-reorder (only within same branch + pin bucket) ----
  const dragHandlers = (t: TabState) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      dragId.current = t.id
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e: React.DragEvent) => {
      const d = dragId.current
      if (!d || d === t.id) return
      const dragged = tabs.find((x) => x.id === d)
      if (
        !dragged ||
        dragged.repoId !== t.repoId ||
        dragged.branch !== t.branch ||
        !!dragged.pinned !== !!t.pinned
      )
        return
      e.preventDefault()
      setDropTargetId(t.id)
    },
    onDragLeave: () => setDropTargetId((id) => (id === t.id ? null : id)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      if (dragId.current) reorderTabs(dragId.current, t.id)
      dragId.current = null
      setDropTargetId(null)
    },
    onDragEnd: () => {
      dragId.current = null
      setDropTargetId(null)
    },
  })

  // ---- terminal chip ----
  const chip = (t: TabState, subIndex?: number) => {
    const proc = processByTab[t.id]
    const busy = tabBusy(proc)
    const live = tabDisplayName(t, proc)
    const label = subIndex === undefined ? live : busy ? live : `term ${subIndex + 1}`
    const isActive = t.id === activeTabId && activePane === 'terminal'
    return (
      <div
        key={t.id}
        className={
          'tab-chip' +
          (isActive ? ' active' : '') +
          (t.pinned ? ' pinned' : '') +
          (dropTargetId === t.id ? ' drop-target' : '')
        }
        title={`${repoName(t.repoId)} · ${t.branch}\n${t.cwd}`}
        onClick={() => setActiveTab(t.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          if (t.repoId !== LOCAL_REPO_ID) togglePinTab(t.id)
        }}
        {...dragHandlers(t)}
      >
        {busy ? (
          <span className="tab-busy" title={`${proc} running`} />
        ) : (
          <Icon name="terminal" size={12} />
        )}
        <span className="tab-name">{label}</span>
        {t.repoId !== LOCAL_REPO_ID && (
          <button
            className="tab-pin"
            title={t.pinned ? 'Unpin' : 'Pin'}
            onClick={(e) => {
              e.stopPropagation()
              togglePinTab(t.id)
            }}
          >
            <Icon name="pin" size={11} />
          </button>
        )}
        <button
          className="tab-close"
          title="Close tab (⌘W)"
          onClick={(e) => {
            e.stopPropagation()
            closeTab(t.id)
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    )
  }

  // ---- expanded active-repo body: branch sub-groups OR flat chips for local ----
  const renderActiveRepoBody = (rid: string) => {
    if (rid === LOCAL_REPO_ID) {
      const localTabs = tabs.filter((t) => t.repoId === LOCAL_REPO_ID)
      return (
        <>
          {localTabs.map((t, i) => chip(t, localTabs.length > 1 ? i : undefined))}
          <button
            className="tab-new"
            title="New local terminal (⌘T)"
            onClick={() => void openLocalTerminal()}
          >
            <Icon name="plus" size={13} />
          </button>
        </>
      )
    }

    const branchOrder: string[] = []
    for (const t of tabs)
      if (t.repoId === rid && !branchOrder.includes(t.branch)) branchOrder.push(t.branch)
    const repoBranches = branchesByRepo[rid] ?? []

    return (
      <>
        {branchOrder.map((br) => {
          const branchTabs = tabs
            .filter((t) => t.repoId === rid && t.branch === br)
            .sort((a, b) => (!!a.pinned === !!b.pinned ? 0 : a.pinned ? -1 : 1))
          const hasActive = branchTabs.some((t) => t.id === activeTabId)
          const overrideKey = `${rid}::${br}`
          // Expansion is purely user-controlled (seeded with the active branch on
          // activation via the effect above). User can always collapse, including
          // the active branch — the active tab is still selected, just hidden.
          const isOpen = expandedOverride.has(overrideKey)
          const bi = repoBranches.findIndex((b) => b.name === br)
          const color = resolveBranchColor(
            branchColorsByRepo[rid]?.[br],
            bi >= 0 ? bi : branchOrder.indexOf(br),
          )
          const toggleOpen = () =>
            setExpandedOverride((prev) => {
              const next = new Set(prev)
              next.has(overrideKey) ? next.delete(overrideKey) : next.add(overrideKey)
              return next
            })
          // Both chevron AND label always toggle expand/collapse. To switch branches,
          // click a terminal chip inside the expanded group — keeps "header = open/close"
          // and "chip = focus" as two clean, non-overlapping gestures.
          return (
            <div
              className={`branch-grp${isOpen ? ' expanded' : ''}${hasActive ? ' has-active' : ''}`}
              key={br}
              style={{ '--branch-color': color } as React.CSSProperties}
            >
              <div className="branch-hd" title={br}>
                <button
                  className="branch-disc"
                  onClick={toggleOpen}
                  title={isOpen ? `Collapse ${br}` : `Expand ${br}`}
                  aria-label={isOpen ? 'Collapse branch' : 'Expand branch'}
                >
                  <Icon
                    name="chevron"
                    size={12}
                    className={`chevron${isOpen ? ' open' : ''}`}
                  />
                </button>
                <button
                  className="branch-label"
                  onClick={toggleOpen}
                  title={`${isOpen ? 'Collapse' : 'Expand'} ${br} · ${branchTabs.length} terminal${branchTabs.length === 1 ? '' : 's'}`}
                >
                  <Icon name="branch" size={11} />
                  <span className="tab-name">{br}</span>
                  <span className="tab-count">{branchTabs.length}</span>
                </button>
              </div>
              {isOpen && branchTabs.map((t, i) => chip(t, branchTabs.length > 1 ? i : undefined))}
            </div>
          )
        })}
        <button
          className="tab-new"
          title="New terminal on active branch (⌘T)"
          onClick={newTabOnActive}
        >
          <Icon name="plus" size={13} />
        </button>
      </>
    )
  }

  return (
    <div className="tabbar">
      {/* Row 1: repos — always visible, never affected by row-2 horizontal scroll. */}
      <div className="tabbar-row tabbar-repos">
        {repoOrder.map((rid) => {
          const isActive = rid === activeRepoId
          const count = repoCount(rid)
          const isLocal = rid === LOCAL_REPO_ID
          const isDropTarget = repoDropId === rid
          return (
            <button
              key={rid}
              className={
                `repo-pill${isActive ? ' active' : ''}${isLocal ? ' local' : ''}` +
                (count === 0 && !isActive ? ' empty' : '') +
                (isDropTarget ? ' drop-target' : '')
              }
              draggable={!isLocal}
              onDragStart={(e) => {
                if (isLocal) return
                repoDragId.current = rid
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                const d = repoDragId.current
                if (!d || d === rid || rid === LOCAL_REPO_ID) return
                e.preventDefault()
                setRepoDropId(rid)
              }}
              onDragLeave={() => setRepoDropId((id) => (id === rid ? null : id))}
              onDrop={(e) => {
                e.preventDefault()
                const d = repoDragId.current
                if (d && d !== rid && rid !== LOCAL_REPO_ID) void reorderRepos(d, rid)
                repoDragId.current = null
                setRepoDropId(null)
              }}
              onDragEnd={() => {
                repoDragId.current = null
                setRepoDropId(null)
              }}
              onClick={() => {
                if (isActive) return
                if (isLocal && count === 0) {
                  void openLocalTerminal()
                  return
                }
                setActiveRepo(rid)
              }}
              title={isLocal ? repoName(rid) : `${repoName(rid)} — drag to reorder`}
            >
              <Icon name={isLocal ? 'terminal' : 'repo'} size={12} />
              <span className="tab-name">{repoName(rid)}</span>
              {count > 0 && <span className="tab-count">{count}</span>}
            </button>
          )
        })}
      </div>
      {/* Row 2: branches + terminals of the active repo (scrolls horizontally). */}
      <div className="tabbar-row tabbar-branches">
        {previewTabs.length > 0 &&
          (() => {
            const portActive = previewTabs.some((pt) => pt.id === activePane)
            const showPorts = portsExpanded || portActive
            return (
              <div className={`ports-grp${showPorts ? ' expanded' : ''}`}>
                <button
                  className="ports-label"
                  title={showPorts ? 'Collapse ports' : 'Show ports'}
                  onClick={() => setPortsExpanded((v) => !v)}
                >
                  <Icon name="globe" size={11} />
                  <span className="tab-name">Ports</span>
                  <span className="tab-count">{previewTabs.length}</span>
                  <Icon name="chevron" size={11} className={`chevron ${showPorts ? 'open' : ''}`} />
                </button>
                {showPorts &&
                  previewTabs.map((pt) => (
                    <div
                      key={pt.id}
                      className={`tab-chip${activePane === pt.id ? ' active' : ''}`}
                      title={pt.url}
                      onClick={() => setPaneActive(pt.id)}
                    >
                      <Icon name="globe" size={12} />
                      <span className="tab-name">{previewLabel(pt.url)}</span>
                      <button
                        className="tab-close"
                        title="Close port"
                        onClick={(e) => {
                          e.stopPropagation()
                          closePreviewTab(pt.id)
                        }}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  ))}
              </div>
            )
          })()}
        {activeRepoId && renderActiveRepoBody(activeRepoId)}
      </div>
    </div>
  )
}
