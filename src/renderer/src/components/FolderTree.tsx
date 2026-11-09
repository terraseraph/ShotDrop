import { useEffect, useState } from 'react'
import type { RemoteEntry } from '@shared/remote'
import { api } from '../api'
import { rollBad } from './BrowseViews'

/** Folder tree for the wide Browse. Children load when a folder is opened; the folders on the way to the current path open themselves. */
export function FolderTree({ destId, rootName, current, diff, onGo }: { destId: string; rootName: string; current: string; diff?: boolean; onGo: (path: string) => void }) {
  const [kids, setKids] = useState<Record<string, RemoteEntry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))

  const load = (path: string): void => {
    if (kids[path]) return
    api.browse(destId, path, !!diff).then(
      (r) => setKids((k) => ({ ...k, [path]: r.entries.filter((e) => e.dir) })),
      () => setKids((k) => ({ ...k, [path]: [] }))
    )
  }

  useEffect(() => {
    const parts = current.split('/').filter(Boolean)
    const trail = ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))]
    setOpen((o) => new Set([...o, ...trail]))
    trail.forEach(load)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, destId])

  const toggle = (p: string): void => {
    setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n })
    load(p)
  }
  const nameOf = (p: string): string => p.split('/').pop() ?? p

  const Node = ({ path, depth, bad = 0 }: { path: string; depth: number; bad?: number }) => {
    const isOpen = open.has(path)
    const children = kids[path]
    return (
      <li role="none">
        <div className={`bw-tn ${path === current ? 'cur' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
          <button className="bw-tw" aria-label={isOpen ? 'Collapse' : 'Expand'} aria-expanded={isOpen} onClick={() => toggle(path)}>{isOpen ? '▾' : '▸'}</button>
          <button className="bw-tl" role="treeitem" aria-selected={path === current} onClick={() => onGo(path)}><span className="bw-fico" aria-hidden />{path ? nameOf(path) : rootName}{bad > 0 && <span className="bw-tbad" title={`${bad} to review`} aria-label={`${bad} to review`} />}</button>
        </div>
        {isOpen && children && children.length > 0 && <ul role="group">{children.map((c) => <Node key={c.path} path={c.path} depth={depth + 1} bad={rollBad(c.rollup)} />)}</ul>}
      </li>
    )
  }

  return <ul className="bw-tree" role="tree" aria-label="Folders"><Node path="" depth={0} /></ul>
}
