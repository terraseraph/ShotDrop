interface ImportMetaEnv {
  /** ShotDrop's own Google OAuth "Desktop app" client, baked in at build time from .env (gitignored). */
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
}
