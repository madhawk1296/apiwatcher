import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Changeset, SpecChange } from "apiwatcher-cli";

import { changesetsDir } from "./env";

/**
 * Changesets are JSON files the scan server keeps synced under DATA_DIR. Read
 * them directly: pulling the CLI package in for this would drag the TypeScript
 * compiler into a server bundle to read a directory of JSON.
 */
async function loadChangesets(dir: string): Promise<Changeset[]> {
  const root = join(dir, "stripe");
  let names: string[];
  try {
    names = (await readdir(root)).filter((n) => n.endsWith(".json") && n !== "index.json");
  } catch {
    return [];
  }
  const sets: Changeset[] = [];
  for (const name of names) {
    try {
      const cs = JSON.parse(await readFile(join(root, name), "utf8")) as Changeset;
      if (cs.schemaVersion === 1 && cs.api === "stripe" && Array.isArray(cs.changes)) sets.push(cs);
    } catch {
      // A half-written file during sync is skipped, not fatal.
    }
  }
  return sets.sort((a, b) => dateOf(a.to).localeCompare(dateOf(b.to)));
}

function dateOf(version: string): string {
  return version.slice(0, 10);
}

function latestKnownVersion(sets: Changeset[]): string | null {
  return sets.length > 0 ? (sets[sets.length - 1]?.to ?? null) : null;
}

export interface VersionSummary {
  version: string;
  from: string;
  /** Release train, e.g. `dahlia`; `legacy` for undated-train versions. */
  train: string;
  /** First version of its train — where Stripe ships breaking changes. */
  boundary: boolean;
  breaking: number;
  deprecating: number;
  additive: number;
  generatedAt: string;
}

export function trainOf(version: string): string {
  return version.split(".")[1] ?? "legacy";
}

export async function allChangesets(): Promise<Changeset[]> {
  try {
    return await loadChangesets(changesetsDir());
  } catch {
    return [];
  }
}

/** Newest first — the order a changelog reads in. */
export async function versionSummaries(): Promise<VersionSummary[]> {
  const sets = await allChangesets();
  const count = (cs: Changeset, s: SpecChange["severity"]) =>
    cs.changes.filter((c) => c.severity === s).length;
  return sets
    .map((cs) => ({
      version: cs.to,
      from: cs.from,
      train: trainOf(cs.to),
      boundary: trainOf(cs.to) !== trainOf(cs.from),
      breaking: count(cs, "breaking"),
      deprecating: count(cs, "deprecating"),
      additive: count(cs, "additive"),
      generatedAt: cs.generatedAt,
    }))
    .reverse();
}

export async function changesetFor(version: string): Promise<Changeset | null> {
  const sets = await allChangesets();
  return sets.find((cs) => cs.to === version) ?? null;
}

export async function latestVersion(): Promise<string | null> {
  return latestKnownVersion(await allChangesets());
}

/** Human label for where a change lives. */
export function locationLabel(c: SpecChange): string {
  switch (c.location) {
    case "requestBody":
      return "request";
    case "queryParam":
      return "query";
    case "pathParam":
      return "path";
    case "response":
      return "response";
    case "event":
      return "webhook";
    case "operation":
      return "endpoint";
  }
}

export function changeSubject(c: SpecChange): string {
  if (c.location === "event") return c.event ?? "";
  if (c.location === "operation") return `${(c.method ?? "").toUpperCase()} ${c.path ?? ""}`;
  return c.resource ?? `${(c.method ?? "").toUpperCase()} ${c.path ?? ""}`;
}
