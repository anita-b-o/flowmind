export type AuthUser = { id: string; email: string; name: string };
export type AuthOrganization = { id: string; name: string; slug: string; role: string };

type SessionSnapshot = {
  accessToken?: string;
  activeOrganizationId?: string;
};

type SessionListener = (snapshot: SessionSnapshot) => void;

let accessToken: string | undefined;
let activeOrganizationId: string | undefined;
const listeners = new Set<SessionListener>();
let refreshHandler: (() => Promise<string | undefined>) | undefined;
let clearHandler: (() => void) | undefined;

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token: string | undefined) {
  accessToken = token;
  emit();
}

export function getActiveOrganizationId() {
  return activeOrganizationId;
}

export function setActiveOrganizationIdValue(organizationId: string | undefined) {
  activeOrganizationId = organizationId;
  emit();
}

export function subscribeSession(listener: SessionListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setRefreshHandler(handler: () => Promise<string | undefined>) {
  refreshHandler = handler;
}

export function setClearHandler(handler: () => void) {
  clearHandler = handler;
}

export function refreshAuthSession() {
  return refreshHandler?.() ?? Promise.resolve(undefined);
}

export function clearAuthSession() {
  accessToken = undefined;
  clearHandler?.();
  emit();
}

function emit() {
  const snapshot = { accessToken, activeOrganizationId };
  listeners.forEach((listener) => listener(snapshot));
}
