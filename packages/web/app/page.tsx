import Link from "next/link";

export default function Home() {
  return (
    <>
      <style>{`html, body { background: #fff !important; background-image: none !important; }`}</style>
      <header className="flex items-center justify-between px-16 py-5">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          APIWatcher
        </Link>
        <Link
          href="/login"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Log In
        </Link>
      </header>

      <main className="px-16 pt-28">
        <h1 className="mx-auto max-w-3xl text-center text-5xl font-semibold leading-tight tracking-tight">
          Get notified the moment an API you use changes.
        </h1>
      </main>
    </>
  );
}
