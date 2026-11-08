import { useRatingSystem } from '../rating'

const KEYS: [string, string][] = [
  ['← →', 'Previous / next'],
  ['1 – 5', 'Rate (0 clears)'],
  ['P', 'Pick'],
  ['X', 'Reject'],
  ['U', 'Clear flag'],
  ['6 7 8 9', 'Red / yellow / green / blue label'],
  ['Shift + key', 'Rate or flag, then go to next'],
  ['F', 'Follow new shots'],
  ['L / G / C', 'Loupe / grid / compare'],
  ['Z or Space', 'Zoom to 100%'],
  ['H', 'Histogram + clipping warning'],
  ['I', 'Info panel'],
  ['Delete', 'Move to recycle bin'],
  ['?', 'This list']
]

const THUMB_KEYS: [string, string] = ['1 2 3', 'Thumbs down / up / love (0 clears)']

export function Shortcuts({ onClose }: { onClose: () => void }) {
  const keys = useRatingSystem() === 'thumbs' ? KEYS.map((k, i) => (i === 1 ? THUMB_KEYS : k)) : KEYS
  return (
    <div className="modal-backdrop scrim" onClick={onClose}>
      <div className="modal sheet" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <dl className="keys">
          {keys.map(([k, v]) => (
            <div key={k}>
              <dt>
                <span className="key" style={{ height: 22 }}>{k}</span>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}
