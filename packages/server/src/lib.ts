/**
 * What the web app imports. The dashboard runs on the same box and reads the
 * same SQLite file; sharing the store keeps one definition of every query.
 */
export { Store } from './db.js';
export type { RepoRecord, ScanRecord, ScanTrigger, UserRecord, NotificationPrefs, NotifyOn } from './db.js';
