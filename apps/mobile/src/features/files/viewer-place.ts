/**
 * The picture viewer is a route of its own, so what it tells the stack it opened from goes through here: the stack
 * listens under its key, passed to the viewer as `from`, and comes back on the picture the person stopped at. The
 * viewer tells the file's id: it may page through the message's videos too, which aren't in the stack.
 */
const listeners = new Map<string, (id: string) => void>();

export function listenViewerPlace(key: string, listener: (id: string) => void) {
  listeners.set(key, listener);
  return () => {
    listeners.delete(key);
  };
}

export const tellViewerPlace = (key: string, id: string) => listeners.get(key)?.(id);
