/**
 * Offline command outbox — pure decision logic, shared between the desk
 * client and node tests. A queued action must never be shown as accepted
 * (INV-04), and anything queued before a take or epoch change requires an
 * explicit reconfirmation before it may be sent again (FR-08, T-008).
 */

/** Decide what may happen to a queued entry right now. */
export function outboxDecision(entry, live) {
  if (entry.state === 'accepted' || entry.state === 'rejected') return 'done';
  if (entry.takeId !== live.takeId) return 'reconfirm'; // queued for an older take
  if (entry.epoch !== live.epoch) return 'reconfirm'; // queued before a RESUME
  if (entry.state === 'reconfirm') return 'reconfirm';
  return 'send';
}

export function loadOutbox(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) ?? '[]');
  } catch {
    return [];
  }
}

export function saveOutbox(storage, key, entries) {
  storage.setItem(key, JSON.stringify(entries));
}

/** Upsert an entry keyed by commandId. */
export function upsert(entries, entry) {
  const idx = entries.findIndex((e) => e.commandId === entry.commandId);
  if (idx >= 0) entries[idx] = { ...entries[idx], ...entry };
  else entries.push(entry);
  return entries;
}
