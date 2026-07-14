"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getStoredSession, logoutLocal } from "../../lib/api-client";

export function RequireAuth({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const { accessToken, organizationId } = getStoredSession();
    if (!accessToken || !organizationId) {
      logoutLocal();
      return;
    }
    setReady(true);
  }, []);

  if (!ready) {
    return <main className="content muted">Loading...</main>;
  }

  return <>{children}</>;
}
