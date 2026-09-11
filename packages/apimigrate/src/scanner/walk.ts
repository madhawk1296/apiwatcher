import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Directories never worth parsing. Keeps a monorepo scan from taking minutes. */
const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'vendor',
  '__snapshots__',
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Files above this size are almost always generated or bundled. */
const MAX_FILE_BYTES = 1_500_000;

export interface WalkOptions {
  /** Extra glob-ish ignore patterns from config. Matched against POSIX relative paths. */
  ignore?: string[];
  maxFiles?: number;
}

/**
 * Very small glob matcher: supports `*` (within a segment), `**` (any depth)
 * and a bare directory name meaning "anywhere". Enough for an `ignore` list in a
 * config file, without pulling in a glob dependency.
 */
export function matchesIgnore(relPath: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    const pattern = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (pattern === '') continue;

    if (!pattern.includes('/') && !pattern.includes('*')) {
      // Bare name: match any path segment.
      if (relPath.split('/').includes(pattern)) return true;
      continue;
    }

    const regex = new RegExp(
      `^${pattern
        .split('**')
        .map((part) =>
          part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\?/g, '[^/]')
            .replace(/\*/g, '[^/]*'),
        )
        .join('.*')}(/.*)?$`,
    );
    if (regex.test(relPath)) return true;
  }
  return false;
}

export function isSourceFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return false;
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export interface SourceFile {
  /** Absolute path. */
  absolute: string;
  /** Repo-relative, POSIX separators. */
  relative: string;
  text: string;
}

/** Collect candidate source files under `root`. */
export async function collectSourceFiles(
  root: string,
  options: WalkOptions = {},
): Promise<{ files: SourceFile[]; skipped: string[] }> {
  const ignore = [...DEFAULT_IGNORES, ...(options.ignore ?? [])];
  const maxFiles = options.maxFiles ?? 20_000;
  const files: SourceFile[] = [];
  const skipped: string[] = [];

  const walkDir = async (dir: string): Promise<void> => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not fatal
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      if (matchesIgnore(rel, ignore)) continue;

      if (entry.isDirectory()) {
        await walkDir(absolute);
        continue;
      }
      if (!entry.isFile() || !isSourceFile(entry.name)) continue;

      try {
        const info = await stat(absolute);
        if (info.size > MAX_FILE_BYTES) {
          skipped.push(`${rel} (${Math.round(info.size / 1024)}KB, likely generated)`);
          continue;
        }
        files.push({ absolute, relative: rel, text: await readFile(absolute, 'utf8') });
      } catch {
        skipped.push(`${rel} (unreadable)`);
      }
    }
  };

  await walkDir(root);
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return { files, skipped };
}

export function findUp(from: string, filename: string, levels = 6): string | null {
  let dir = from;
  for (let i = 0; i < levels; i++) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
