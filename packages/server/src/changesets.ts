import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { defaultChangesetDir, loadChangesets, latestKnownVersion, type Changeset } from 'apiwatcher-cli';

/**
 * Keeps a local copy of the published changesets current.
 *
 * The spec watcher commits new changesets to the repo; the server pulls them
 * from there rather than shipping them in its own build, so a Stripe release
 * never requires a server deploy. On first boot the directory is seeded from the
 * changesets bundled in the installed CLI package, so the server works offline
 * from the start.
 */
export class ChangesetSync {
  readonly dir: string;
  private readonly baseUrl: string;

  constructor(dataDir: string, indexUrl: string) {
    this.dir = join(dataDir, 'changesets');
    // index.json lives beside the changeset files; derive their URL from its.
    this.baseUrl = indexUrl.replace(/\/index\.json$/, '');
    if (this.baseUrl === indexUrl) throw new Error(`CHANGESET_INDEX_URL must end in /index.json: ${indexUrl}`);
    this.indexUrl = indexUrl;
  }

  private readonly indexUrl: string;

  private get stripeDir(): string {
    return join(this.dir, 'stripe');
  }

  /** Copy the CLI's bundled changesets in if we have none yet. */
  async seed(): Promise<void> {
    await mkdir(this.stripeDir, { recursive: true });
    const present = (await readdir(this.stripeDir)).filter((n) => n.endsWith('.json') && n !== 'index.json');
    if (present.length > 0) return;

    const bundled = join(defaultChangesetDir(), 'stripe');
    if (!existsSync(bundled)) return;
    await cp(bundled, this.stripeDir, { recursive: true });
  }

  /**
   * Fetch anything published that we do not have. Returns the newest version
   * known after syncing, and whether anything new arrived.
   */
  async sync(): Promise<{ latest: string | null; added: string[] }> {
    const added: string[] = [];
    const res = await fetch(this.indexUrl, { headers: { 'user-agent': 'apiwatcher-server' } });
    if (!res.ok) throw new Error(`changeset index fetch failed: ${res.status}`);

    const index = (await res.json()) as { entries?: Array<{ file: string; to: string }> };
    for (const entry of index.entries ?? []) {
      const target = join(this.stripeDir, entry.file);
      if (existsSync(target)) continue;

      const fileRes = await fetch(`${this.baseUrl}/${entry.file}`, { headers: { 'user-agent': 'apiwatcher-server' } });
      if (!fileRes.ok) throw new Error(`changeset ${entry.file} fetch failed: ${fileRes.status}`);
      const text = await fileRes.text();
      // Parse before writing so a truncated download never lands on disk.
      JSON.parse(text);
      await writeFile(target, text, 'utf8');
      added.push(entry.to);
    }

    const sets = await this.load();
    return { latest: latestKnownVersion(sets), added };
  }

  async load(): Promise<Changeset[]> {
    return loadChangesets(this.dir);
  }

  async latest(): Promise<string | null> {
    return latestKnownVersion(await this.load());
  }

  /** Read one changeset file's raw text; used to hand full data to the admin API. */
  async readRaw(file: string): Promise<string | null> {
    const path = join(this.stripeDir, file);
    if (!existsSync(path) || file.includes('/') || file.includes('..')) return null;
    return readFile(path, 'utf8');
  }
}
