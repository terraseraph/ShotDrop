// Thumbs ratings, shared by the UI and the XMP sidecar writer/reader.
//
// Thumbs live on the 0-5 star scale (down 1, up 4, love 5), so sorting, filters, the sidecars' xmp:Rating
// (what Lightroom and Capture One read) and switching systems keep working with no migration.
// Reading back, 1-2 is down, 3-4 is up and 5 is love, so stars set elsewhere still show as a thumb.

export type Thumb = 'down' | 'up' | 'love'

export const THUMB_RATING: Record<Thumb, number> = { down: 1, up: 4, love: 5 }

export const thumbOf = (rating: number): Thumb | null => (rating <= 0 ? null : rating <= 2 ? 'down' : rating <= 4 ? 'up' : 'love')

/** Words for each thumb: the UI text and the keyword written to sidecars (under "ShotDrop" in Lightroom's keyword list). */
export const THUMB_WORD: Record<Thumb, string> = { down: 'Thumbs down', up: 'Liked', love: 'Loved' }
export const KEYWORD_PARENT = 'ShotDrop'
