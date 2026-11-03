// One launch per tab, with ownership checks across asynchronous PTY creation.
export function createTerminalLauncher({ start, dispose, onChange = () => {} }) {
  let state = 'dormant';
  let pending = null;
  let resource = null;
  let closed = false;
  let generation = 0;
  let exited = false;
  const change = (next, error = null) => {
    state = next;
    onChange(next, error);
  };

  return {
    get state() { return state; },
    ensure({ retry = false } = {}) {
      if (closed) return Promise.resolve(null);
      if (pending) return pending;
      if (state === 'running') return Promise.resolve(resource);
      if ((state === 'failed' || state === 'exited') && !retry) return Promise.resolve(null);
      const attempt = ++generation;
      exited = false;
      pending = Promise.resolve().then(async () => {
        if (resource) {
          const previous = resource;
          resource = null;
          await dispose(previous);
        }
        if (closed || attempt !== generation) return null;
        const value = await start(() => !closed && attempt === generation);
        if (closed || attempt !== generation) {
          if (value) await dispose(value);
          return null;
        }
        resource = value;
        change(exited ? 'exited' : 'running');
        return value;
      }).catch((error) => {
        if (!closed && attempt === generation) change('failed', error);
        throw error;
      }).finally(() => {
        pending = null;
      });
      change('starting');
      return pending;
    },
    markExited() {
      exited = true;
      if (state === 'running') change('exited');
    },
    close() {
      if (closed) return;
      closed = true;
      generation++;
      const previous = resource;
      resource = null;
      change('closed');
      if (previous) return dispose(previous);
    },
  };
}
