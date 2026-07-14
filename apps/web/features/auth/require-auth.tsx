"use client";

import { useEffect, type ReactNode } from "react";
import { useAuth } from "./use-auth";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();

  useEffect(() => {
    if (status === "anonymous") {
      window.location.href = "/login";
    }
  }, [status]);

  if (status === "loading" || status === "anonymous") {
    return <main className="content muted">Loading...</main>;
  }

  return <>{children}</>;
}
