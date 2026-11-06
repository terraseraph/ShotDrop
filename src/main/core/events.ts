import { EventEmitter } from 'node:events'
import type { ServerEvent } from '@shared/types'

/** Typed in-process event bus. The API streams these to clients over SSE. */
export class Bus {
  private ee = new EventEmitter()

  constructor() {
    this.ee.setMaxListeners(100)
  }

  emit(e: ServerEvent): void {
    this.ee.emit('event', e)
  }

  on(fn: (e: ServerEvent) => void): () => void {
    this.ee.on('event', fn)
    return () => this.ee.off('event', fn)
  }
}
