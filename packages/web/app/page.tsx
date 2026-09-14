import Link from "next/link";

export default function Home() {
  return (
    <>
      <style>{`html, body { background: #fff !important; background-image: none !important; }`}</style>
      <header className="flex items-center justify-between px-8 py-5">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          APIWatcher
        </Link>
        <Link href="/login" className="text-sm hover:underline">
          Log In
        </Link>
      </header>
    </>
  );
}
