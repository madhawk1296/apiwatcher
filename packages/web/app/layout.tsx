import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";

import { FONT_COOKIE, fontClassNames, parseFontCookie } from "@/lib/fonts";

export const metadata: Metadata = {
  title: { default: "APIWatcher", template: "%s · APIWatcher" },
  description:
    "Get notified the moment an API you use changes — and see every affected file and line in your code.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The chosen fonts come from a cookie set by the picker, so the server
  // renders the same pair the browser will show — no flash of the wrong font.
  const jar = await cookies();
  const fonts = parseFontCookie(jar.get(FONT_COOKIE)?.value);

  return (
    <html
      lang="en"
      className={`${fontClassNames} h-full antialiased`}
      style={
        {
          "--font-heading": `var(${fonts.heading.variable})`,
          "--font-body": `var(${fonts.body.variable})`,
        } as React.CSSProperties
      }
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
