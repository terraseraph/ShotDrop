import type { Shot } from '@shared/types'
import { Icon } from './Icon'

/** Pick and Reject as icon + word buttons: outlined in their colour when off, filled when on. Clicking the current state clears it. */
export function FlagButtons({ shot, onPick, onReject, onUnflag, compact = false }: { shot: Shot; onPick: (id: number) => void; onReject: (id: number) => void; onUnflag: (id: number) => void; compact?: boolean }) {
  return (
    <span className="flagbtns">
      <button className={`fb pick ${shot.flag === 1 ? 'on' : ''}`} aria-pressed={shot.flag === 1} title="Pick: mark as a keeper (P)" onClick={() => (shot.flag === 1 ? onUnflag : onPick)(shot.id)}>
        <Icon name="flag" size={compact ? 14 : 15} />Pick
      </button>
      <button className={`fb rej ${shot.flag === -1 ? 'on' : ''}`} aria-pressed={shot.flag === -1} title="Reject: mark to throw away (X)" onClick={() => (shot.flag === -1 ? onUnflag : onReject)(shot.id)}>
        <Icon name="close" size={compact ? 14 : 15} />Reject
      </button>
    </span>
  )
}
