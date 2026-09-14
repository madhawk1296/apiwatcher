import { redirect } from "next/navigation";

import { currentUser, signIn } from "@/auth";
import { Footer, TopBar } from "@/components/chrome";

export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: PageProps<"/login">) {
  if (await currentUser()) redirect("/app");
  const params = await searchParams;
  const next = typeof params.next === "string" && params.next.startsWith("/app") ? params.next : "/app";

  return (
    <>
      <TopBar />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-center px-6 py-24">
        <div className="max-w-md">
          <h1 className="text-4xl font-light">Sign in with GitHub.</h1>
          <p className="mt-4 leading-relaxed text-ink-2">
            You&rsquo;ll see every repository where the apiwatcher App is installed and you have access. That&rsquo;s
            the only thing sign-in is for — the App does the rest from GitHub.
          </p>
          <form
            className="mt-8"
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: next });
            }}
          >
            <button type="submit" className="rounded-sm bg-ink px-5 py-3 text-paper hover:bg-accent-ink">
              Continue with GitHub
            </button>
          </form>
          <p className="mt-6 text-sm text-ink-3">
            Not installed yet? <a className="underline hover:text-ink" href="/">Start there.</a>
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}
