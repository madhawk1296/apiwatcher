import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SdkMethodRef } from '../changeset/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Maps an HTTP endpoint to the stripe-node calls that reach it, and back.
 *
 * Generated from the stripe package's own generated resource files, so it is
 * ground truth rather than a guess at Stripe's pluralization rules.
 */
export interface MethodMap {
  /** stripe-node version the map was generated from. */
  sdkVersion: string;
  generatedAt: string;
  /** `"post /v1/payment_intents"` -> [{ namespace: 'paymentIntents', method: 'create' }] */
  byEndpoint: Record<string, SdkMethodRef[]>;
  /** `"paymentIntents.create"` -> { method: 'post', path: '/v1/payment_intents' } */
  byCall: Record<string, { method: string; path: string }>;
}

export function endpointKey(method: string, path: string): string {
  return `${method.toLowerCase()} ${path}`;
}

export function callKey(namespace: string, method: string): string {
  return `${namespace}.${method}`;
}

const EMPTY: MethodMap = {
  sdkVersion: 'unknown',
  generatedAt: new Date(0).toISOString(),
  byEndpoint: {},
  byCall: {},
};

/** Walk up from this module looking for the committed map. */
export function defaultMethodMapPath(): string | null {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'data', 'stripe', 'method-map.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The webhook event types a spec version defines. */
export interface EventCatalog {
  apiVersion: string;
  generatedAt: string;
  events: string[];
}

export function defaultEventCatalogPath(): string | null {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'data', 'stripe', 'events.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Known event types, used to tell a real webhook event string apart from any
 * other dotted lowercase literal. Without it the scanner has to guess from
 * context and reports lower confidence.
 */
export async function loadEventCatalog(file?: string): Promise<ReadonlySet<string> | null> {
  const path = file ? resolve(file) : defaultEventCatalogPath();
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as EventCatalog;
    return Array.isArray(parsed.events) ? new Set(parsed.events) : null;
  } catch {
    return null;
  }
}

export async function loadMethodMap(file?: string): Promise<MethodMap> {
  const path = file ? resolve(file) : defaultMethodMapPath();
  if (!path || !existsSync(path)) return EMPTY;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as MethodMap;
  if (!parsed.byEndpoint || !parsed.byCall) {
    throw new Error(`${path}: not a method map (missing byEndpoint/byCall)`);
  }
  return parsed;
}

/**
 * Endpoint paths in the spec use `{customer}`; stripe-node builds them from
 * template literals. Both sides normalize to `{}` so they compare equal
 * regardless of what the parameter happens to be called.
 */
export function normalizePath(path: string): string {
  return path.replace(/\{[^}]*\}/g, '{}');
}

/**
 * Parameter names differ between sources — the spec says `{intent}`, stripe-node
 * builds `{id}` — so lookups fall back to a name-insensitive index. Built once
 * per map and cached, since the differ calls this for every operation.
 */
const normalizedIndexes = new WeakMap<MethodMap, Map<string, SdkMethodRef[]>>();

function normalizedIndex(map: MethodMap): Map<string, SdkMethodRef[]> {
  const cached = normalizedIndexes.get(map);
  if (cached) return cached;

  const index = new Map<string, SdkMethodRef[]>();
  for (const [key, refs] of Object.entries(map.byEndpoint)) {
    const sep = key.indexOf(' ');
    const normalized = `${key.slice(0, sep)} ${normalizePath(key.slice(sep + 1))}`;
    const bucket = index.get(normalized);
    if (bucket) bucket.push(...refs);
    else index.set(normalized, [...refs]);
  }
  normalizedIndexes.set(map, index);
  return index;
}

export function lookupSdkMethods(map: MethodMap, method: string, path: string): SdkMethodRef[] {
  const exact = map.byEndpoint[endpointKey(method, path)];
  if (exact) return exact;
  return normalizedIndex(map).get(`${method.toLowerCase()} ${normalizePath(path)}`) ?? [];
}
