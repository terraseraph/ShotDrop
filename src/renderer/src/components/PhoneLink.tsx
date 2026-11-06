import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { CopyField } from './ConnectionCard'

/** Big QR for a gallery URL, with the PIN under it. The QR holds the URL only, never the PIN. */
export function PhoneLink({ url, pin, size = 240 }: { url: string; pin?: string; size?: number }) {
  const [qr, setQr] = useState<string | null>(null)
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 2, width: size * 2, color: { dark: '#0b0b0d', light: '#ffffff' } })
      .then(setQr)
      .catch(() => setQr(null))
  }, [url, size])

  return (
    <div className="phone-link">
      {qr && <img className="phone-qr" style={{ width: size, height: size }} src={qr} alt={`QR code for ${url}`} />}
      {pin && (
        <div className="phone-pin">
          <span className="muted small">PIN</span>
          <span className="mono">{pin}</span>
        </div>
      )}
      <CopyField label="Link" value={url} />
    </div>
  )
}
