import { adminToken, serverUrl } from "./env";

/**
 * The scan server's admin API, reached over loopback with the shared admin
 * token. The dashboard never scans anything itself; it asks the server to.
 */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const token = adminToken();
  if (!token) throw new Error("ADMIN_TOKEN is not configured for the web app");
  return fetch(`${serverUrl()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    cache: "no-store",
  });
}

export async function requestScan(fullName: string): Promise<{ ok: boolean; message: string }> {
  const res = await call(`/admin/scan?repo=${encodeURIComponent(fullName)}&post=1`, { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { queued?: string; error?: string };
  if (!res.ok) return { ok: false, message: body.error ?? `server returned ${res.status}` };
  return { ok: true, message: body.queued === "coalesced" ? "A scan is already running; another will follow it." : "Scan queued." };
}

export async function serverHealth(): Promise<{ ok: boolean; queue?: { size: number; inFlight: number } }> {
  try {
    const res = await fetch(`${serverUrl()}/health`, { cache: "no-store" });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { status: string; queue: { size: number; inFlight: number } };
    return { ok: body.status === "ok", queue: body.queue };
  } catch {
    return { ok: false };
  }
}
