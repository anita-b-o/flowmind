"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authFetch } from "../../lib/api-client";
import {
  clearAuthSession,
  setAccessToken,
  setActiveOrganizationIdValue,
  setClearHandler,
  setRefreshHandler,
  type AuthOrganization,
  type AuthUser
} from "./session-store";

const ACTIVE_ORG_KEY = "flowmind.activeOrganizationId";
const LEGACY_KEYS = ["accessToken", "refreshToken", "organizationId"];

type AuthStatus = "loading" | "authenticated" | "anonymous";

type AuthResponse = {
  accessToken: string;
  user: AuthUser;
  defaultOrganizationId?: string;
};

type MeResponse = {
  user: AuthUser;
  organizations: AuthOrganization[];
};

type AuthContextValue = {
  status: AuthStatus;
  accessToken?: string;
  user?: AuthUser;
  organizations: AuthOrganization[];
  activeOrganizationId?: string;
  login: (response: AuthResponse) => Promise<void>;
  logout: () => Promise<void>;
  setActiveOrganizationId: (organizationId: string) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [accessTokenState, setAccessTokenState] = useState<string | undefined>();
  const [user, setUser] = useState<AuthUser | undefined>();
  const [organizations, setOrganizations] = useState<AuthOrganization[]>([]);
  const [activeOrganizationId, setActiveOrganizationIdState] = useState<string | undefined>();

  const applyActiveOrganization = useCallback((items: AuthOrganization[], preferred?: string, fallback?: string) => {
    const validPreferred = preferred && items.some((organization) => organization.id === preferred) ? preferred : undefined;
    const next = validPreferred ?? (fallback && items.some((organization) => organization.id === fallback) ? fallback : undefined) ?? items[0]?.id;
    setActiveOrganizationIdState(next);
    setActiveOrganizationIdValue(next);
    if (typeof window !== "undefined") {
      if (next) {
        localStorage.setItem(ACTIVE_ORG_KEY, next);
      } else {
        localStorage.removeItem(ACTIVE_ORG_KEY);
      }
    }
    return next;
  }, []);

  const applySession = useCallback(
    async (response: AuthResponse) => {
      setAccessToken(response.accessToken);
      setAccessTokenState(response.accessToken);
      const me = await authFetch<MeResponse>("/auth/me", {
        headers: { authorization: `Bearer ${response.accessToken}` }
      });
      setUser(me.user);
      setOrganizations(me.organizations);
      const stored = typeof window === "undefined" ? undefined : localStorage.getItem(ACTIVE_ORG_KEY) ?? undefined;
      applyActiveOrganization(me.organizations, stored, response.defaultOrganizationId);
      setStatus("authenticated");
    },
    [applyActiveOrganization]
  );

  const clearLocalSession = useCallback(() => {
    setAccessToken(undefined);
    setAccessTokenState(undefined);
    setUser(undefined);
    setOrganizations([]);
    setActiveOrganizationIdState(undefined);
    setActiveOrganizationIdValue(undefined);
    setStatus("anonymous");
    queryClient.clear();
  }, [queryClient]);

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch<AuthResponse>("/auth/refresh", { method: "POST" });
      await applySession(response);
      return response.accessToken;
    } catch (error) {
      clearLocalSession();
      if ((error as { status?: number }).status === 401) {
        return undefined;
      }
      throw error;
    }
  }, [applySession, clearLocalSession]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      LEGACY_KEYS.forEach((key) => localStorage.removeItem(key));
    }
    setRefreshHandler(refresh);
    setClearHandler(clearLocalSession);
    void refresh().finally(() => {
      setStatus((current) => (current === "loading" ? "anonymous" : current));
    });
  }, [clearLocalSession, refresh]);

  const login = useCallback(
    async (response: AuthResponse) => {
      await applySession(response);
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    try {
      await authFetch("/auth/logout", { method: "POST" });
    } catch {
      // Local session must be cleared even if the network is unavailable.
    } finally {
      clearLocalSession();
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
    }
  }, [clearLocalSession]);

  const setActiveOrganizationId = useCallback(
    (organizationId: string) => {
      applyActiveOrganization(organizations, organizationId);
    },
    [applyActiveOrganization, organizations]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      accessToken: accessTokenState,
      user,
      organizations,
      activeOrganizationId,
      login,
      logout,
      setActiveOrganizationId
    }),
    [status, accessTokenState, user, organizations, activeOrganizationId, login, logout, setActiveOrganizationId]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}
