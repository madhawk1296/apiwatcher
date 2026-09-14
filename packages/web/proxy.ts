import { NextResponse } from "next/server";

import { auth } from "@/auth";

/**
 * Optimistic gate on the dashboard: no session cookie, straight to sign-in.
 * Every page and action still verifies the session itself — this only saves a
 * render for the obvious case.
 */
export default auth((req) => {
  if (!req.auth && req.nextUrl.pathname.startsWith("/app")) {
    const login = new URL("/login", req.nextUrl);
    login.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/app/:path*"],
};
