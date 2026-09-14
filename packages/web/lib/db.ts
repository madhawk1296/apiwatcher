import { Store } from "@apiwatcher/server";

import { sqlitePath } from "./env";

/**
 * The same SQLite file the scan server writes. One connection per process,
 * kept on globalThis so dev-mode module reloads do not pile up handles.
 */
const g = globalThis as unknown as { __apiwatcherStore?: Store };

export function store(): Store {
  if (!g.__apiwatcherStore) g.__apiwatcherStore = new Store(sqlitePath());
  return g.__apiwatcherStore;
}
