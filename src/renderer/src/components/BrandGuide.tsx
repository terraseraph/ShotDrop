import { useState } from 'react'

interface Step {
  t: string
  s: string
}
const GUIDE: Record<string, { short: string; steps: Step[] }> = {
  Sony: {
    short: 'Sony',
    steps: [
      { t: 'Network → Transfer/Remote → FTP Transfer Func. → Server Setting', s: 'Pick an empty server slot.' },
      { t: 'Destination settings → enter the address, port, user and password', s: 'Secure protocol Off, passive mode On.' },
      { t: 'FTP Transfer Func. → On, Auto FTP Transfer → On', s: 'Take a shot. It shows up here in a few seconds.' }
    ]
  },
  Canon: {
    short: 'Canon',
    steps: [
      { t: 'Network settings → Connection option settings → FTP transfer', s: 'Run the wizard: pick the Wi-Fi network, then FTP (not SFTP).' },
      { t: 'Enter the address, port, user and password', s: 'Passive mode Enable, proxy none, target folder Root.' },
      { t: 'Transfer settings → Auto transfer → Enable', s: 'Take a shot. It shows up here in a few seconds.' }
    ]
  },
  Nikon: {
    short: 'Nikon',
    steps: [
      { t: 'Network menu → Connect to FTP server → Create profile', s: 'Join the same Wi-Fi as this PC.' },
      { t: 'Server type FTP, then address, port, user and password', s: 'Passive mode On.' },
      { t: 'Options → Auto send → On', s: 'Take a shot. It shows up here in a few seconds.' }
    ]
  },
  Fujifilm: {
    short: 'Fuji',
    steps: [
      { t: 'Network/USB settings → FTP transfer settings → Server settings', s: 'Server and port from the card, passive mode On.' },
      { t: 'User ID and password from the card', s: 'Leave the upload folder blank.' },
      { t: 'Join the same Wi-Fi, then Auto Image Transfer Order → On', s: 'Take a shot. It shows up here in a few seconds.' }
    ]
  },
  Other: {
    short: 'Other',
    steps: [
      { t: 'Find FTP, FTP transfer or Network upload in the camera menu', s: 'Plain FTP, not SFTP or FTPS.' },
      { t: 'Enter the address, port, user and password', s: 'Passive mode on, folder blank.' },
      { t: 'Join the same Wi-Fi and turn on automatic transfer', s: 'Take a shot. It shows up here in a few seconds.' }
    ]
  }
}

const KEY = 'shotdrop.brand'
const saved = (): string => {
  try {
    const b = localStorage.getItem(KEY)
    return b && GUIDE[b] ? b : 'Sony'
  } catch {
    return 'Sony'
  }
}

/** Brand tabs plus three numbered steps. `compact` is the phone sheet (titles only, short labels). */
export function BrandGuide({ compact }: { compact?: boolean }) {
  const [brand, setBrand] = useState(saved)
  const pick = (b: string): void => {
    setBrand(b)
    try {
      localStorage.setItem(KEY, b)
    } catch {
      /* not remembered */
    }
  }
  return (
    <>
      <div className="su-tabs" role="tablist" aria-label="Camera brand">
        {Object.entries(GUIDE).map(([b, g]) => (
          <button key={b} role="tab" aria-selected={brand === b} className={brand === b ? 'on' : ''} onClick={() => pick(b)}>
            {compact ? g.short : b}
          </button>
        ))}
      </div>
      <ol className="su-steps">
        {GUIDE[brand].steps.map((st, i) => (
          <li key={brand + i}>
            <span className={`key su-n ${i === 0 ? 'on' : ''}`}>{i + 1}</span>
            <div>
              <div className="t">{st.t}</div>
              {!compact && <div className="s">{st.s}</div>}
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}
