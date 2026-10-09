/** In-process pub/sub that fans factory events out to SSE clients. */
import type { FactoryEvent } from './types.ts';

type Listener = (event: FactoryEvent) => void;
const listeners = new Set<Listener>();

export function emit(event: FactoryEvent): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch {
      // a broken client must not break the factory
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
