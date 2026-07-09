export function createDebouncer({ delayMs = 3000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const pending = new Map(); // batchKey -> { items, timer, onFlush }
  function push(batchKey, item, onFlush) {
    let entry = pending.get(batchKey);
    if (!entry) { entry = { items: [], timer: null, onFlush }; pending.set(batchKey, entry); }
    entry.items.push(item);
    entry.onFlush = onFlush;
    if (entry.timer) clearTimeoutFn(entry.timer);
    entry.timer = setTimeoutFn(() => {
      pending.delete(batchKey);
      entry.onFlush(entry.items);
    }, delayMs);
  }
  return { push };
}
