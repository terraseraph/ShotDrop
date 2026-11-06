const KEYS: [string, string][] = [
  ['← →', 'Previous / next'],
  ['1 – 5', 'Rate (0 clears)'],
  ['P', 'Pick'],
  ['X', 'Reject'],
  ['U', 'Clear flag'],
  ['6 7 8 9', 'Red / yellow / green / blue label'],
  ['Shift + key', 'Rate or flag, then go to next'],
  ['F', 'Follow new shots'],
  ['G / E', 'Grid / loupe'],
  ['Z or Space', 'Zoom to 100%'],
  ['I', 'Info panel'],
  ['Delete', 'Move to recycle bin'],
  ['?', 'This list']
]

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <dl className="keys">
          {KEYS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
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
