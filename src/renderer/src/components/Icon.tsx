const PATHS: Record<string, string> = {
  cloud: 'M7 18a4.5 4.5 0 0 1-.5-8.97A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5H7Z',
  follow: 'M12 5v14M5 12l7 7 7-7',
  loupe: 'M4 5h16v11H4zM8 19h8',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  close: 'M6 6l12 12M18 6 6 18',
  prev: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  folder: 'M3 6h6l2 2h10v11H3z',
  plus: 'M12 5v14M5 12h14',
  chevron: 'M6 9l6 6 6-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  check: 'M5 12l5 5 9-11',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  dock: 'M4 5h16v14H4zM14 5v14',
  flag: 'M5 21V4h11l-2 4 2 4H5',
  alert: 'M12 8v5M12 16.5v.01',
  info: 'M12 11v6M12 7.5v.01',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4l12 8-12 8Z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  terminal: 'M4 6l5 6-5 6M12 18h8',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6Z',
  layers: 'M12 3l9 5-9 5-9-5ZM3 13l9 5 9-5',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  raw: 'M4 5h16v14H4zM8 9v6M8 9h3a1.5 1.5 0 0 1 0 3H8M11 12l2 3',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z',
  drive: 'M8.5 4h7l6 10.5-3.5 6h-12L2.5 14.5Z M8.5 4l6 10.5M15.5 4l-6 10.5M2.5 14.5h19',
  dropbox: 'M7 3l5 3.2L7 9.4 2 6.2ZM17 3l5 3.2-5 3.2-5-3.2ZM7 9.4l5 3.2-5 3.2-5-3.2ZM17 9.4l5 3.2-5 3.2-5-3.2ZM7 17l5 3 5-3'
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  )
}
