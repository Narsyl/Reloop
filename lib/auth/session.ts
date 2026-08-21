import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};

export type CurrentSession = {
  sessionId: string;
  user: SessionUser;
};

/**
 * Current session for this request (memoised per request via React cache).
 * Returns null when not signed in.
 */
export const getSession = cache(async (): Promise<CurrentSession | null> => {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) return null;
  return {
    sessionId: result.session.id,
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      image: result.user.image ?? null,
    },
  };
});

/** Redirects to /login when not signed in. */
export async function requireUser(): Promise<CurrentSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
