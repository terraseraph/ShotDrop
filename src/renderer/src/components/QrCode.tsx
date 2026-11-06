import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** A real QR for `value`, on a white tile (QR readers need the light quiet zone). */
export function QrCode({ value, size = 132, label }: { value: string; size?: number; label: string }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let live = true
    QRCode.toDataURL(value, { margin: 0, width: size * 3, color: { dark: '#111111', light: '#ffffff' } })
      .then((s) => live && setSrc(s))
      .catch(() => live && setSrc(''))
    return () => {
      live = false
    }
  }, [value, size])
  const pad = Math.round(size * 0.075)
  return (
    <div className="su-qr" style={{ width: size, height: size, padding: pad }}>
      {src && <img src={src} alt={label} width={size - pad * 2} height={size - pad * 2} />}
    </div>
  )
}
