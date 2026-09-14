"use server";

import { revalidatePath } from "next/cache";

import { currentUser } from "@/auth";
import { store } from "@/lib/db";
import { requestScan } from "@/lib/server-api";

/**
 * Every action re-checks the session and the user's access to the repo. The
 * URL and the form are untrusted; the database is the authority.
 */
export async function scanNow(fullName: string): Promise<{ ok: boolean; message: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Sign in first." };
  if (!store().userCanSeeRepo(user.githubId, fullName)) return { ok: false, message: "Not your repository." };
  const result = await requestScan(fullName);
  revalidatePath(`/app/repos/${fullName}`);
  return result;
}

export async function savePrefs(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, message: "Sign in first." };

  const email = String(formData.get("email") ?? "").trim() || null;
  const notifyOn = String(formData.get("notifyOn") ?? "breaking");
  const slack = String(formData.get("slackWebhook") ?? "").trim() || null;

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: "That email does not look right." };
  if (!["breaking", "deprecating", "never"].includes(notifyOn)) return { ok: false, message: "Unknown notification level." };
  if (slack && !slack.startsWith("https://hooks.slack.com/")) return { ok: false, message: "Slack webhooks start with https://hooks.slack.com/." };

  store().setPrefs({ githubId: user.githubId, email, notifyOn: notifyOn as "breaking" | "deprecating" | "never", slackWebhook: slack });
  revalidatePath("/app/settings");
  return { ok: true, message: "Saved." };
}
