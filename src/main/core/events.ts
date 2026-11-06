import { EventEmitter } from 'node:events'
import type { ServerEvent } from '@shared/types'

const KEEP = 1000

/**
 * Typed in-process event bus. The API streams these to clients over SSE, and keeps the last
 * KEEP events numbered so clients that can't hold an SSE stream open (e.g. through a Cloudflare
 * quick tunnel, which doesn't support SSE) can poll for what changed.
 */
export class Bus {
  private ee = new EventEmitter()
  private log: { seq: number; event: ServerEvent }[] = []
  private seq = 0

  constructor() {
    this.ee.setMaxListeners(100)
  }

  emit(e: ServerEvent): void {
    // Status is sent whole on every poll, so only keep data events in the log.
    if (e.type !== 'status') {
      this.log.push({ seq: ++this.seq, event: e })
      if (this.log.length > KEEP) this.log.shift()
    }
    this.ee.emit('event', e)
  }

  on(fn: (e: ServerEvent) => void): () => void {
    this.ee.on('event', fn)
    return () => this.ee.off('event', fn)
  }

  /** Events after `after`. `reset` means the caller fell too far behind and should reload everything. */
  since(after: number): { seq: number; events: ServerEvent[]; reset: boolean } {
    const oldest = this.log[0]?.seq ?? this.seq + 1
    if (after > this.seq || (after < oldest - 1 && this.log.length > 0)) return { seq: this.seq, events: [], reset: after !== this.seq }
    return { seq: this.seq, events: this.log.filter((l) => l.seq > after).map((l) => l.event), reset: false }
  }

  get current(): number {
    return this.seq
  }
}
