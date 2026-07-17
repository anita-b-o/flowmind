"use client";

import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorMessage } from "../../components/error-message";
import { RequireAuth } from "../../features/auth/require-auth";
import { canDeleteConnections, canListConnections, canManageConnections } from "../../features/auth/rbac";
import { useAuth } from "../../features/auth/use-auth";
import {
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useDisableConnection,
  useEnableConnection,
  useRotateConnection,
  useTestConnection,
  useUpdateConnection
} from "../../features/connections/hooks";
import { HttpConnectionForm, RotateConnectionSecretDialog, SmtpConnectionForm, TestConnectionDialog } from "../../features/connections/forms";
import type { ConnectionSummary, ConnectionType, CreateConnectionDto, HttpAuthScheme } from "../../features/connections/types";

export default function ConnectionsPage() {
  const [type, setType] = useState<ConnectionType | "">("");
  const [authScheme, setAuthScheme] = useState<HttpAuthScheme | "">("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [createType, setCreateType] = useState<"HTTP" | "SMTP" | null>(null);
  const [selected, setSelected] = useState<ConnectionSummary | null>(null);
  const [rotate, setRotate] = useState<ConnectionSummary | null>(null);
  const [test, setTest] = useState<ConnectionSummary | null>(null);
  const [toggle, setToggle] = useState<ConnectionSummary | null>(null);
  const [remove, setRemove] = useState<ConnectionSummary | null>(null);
  const connections = useConnections({ type, authScheme, status, q });
  const createConnection = useCreateConnection();
  const updateConnection = useUpdateConnection();
  const rotateConnection = useRotateConnection();
  const enableConnection = useEnableConnection();
  const disableConnection = useDisableConnection();
  const deleteConnection = useDeleteConnection();
  const testConnection = useTestConnection();
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;
  const error = createConnection.error ?? rotateConnection.error ?? enableConnection.error ?? disableConnection.error ?? deleteConnection.error ?? testConnection.error ?? updateConnection.error;

  async function create(dto: CreateConnectionDto) {
    await createConnection.mutateAsync(dto);
    setCreateType(null);
  }

  return (
    <RequireAuth>
      <main className="content stack">
        <div className="workflow-title-row">
          <div>
            <h1>Connections</h1>
            <p className="muted">Credentials are encrypted, reusable, and never shown after saving.</p>
          </div>
          {canManageConnections(role) && (
            <div className="workflow-actions">
              <button type="button" onClick={() => setCreateType("HTTP")}>New HTTP</button>
              <button type="button" onClick={() => setCreateType("SMTP")}>New SMTP</button>
            </div>
          )}
        </div>
        {!canListConnections(role) && <section className="panel">You do not have permission to view connections.</section>}
        {canListConnections(role) && (
          <>
            <section className="panel workflow-form-grid">
              <label>Search<input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name or description" /></label>
              <label>Type<select value={type} onChange={(event) => setType(event.target.value as ConnectionType | "")}>
                <option value="">All</option><option value="HTTP">HTTP</option><option value="SMTP">SMTP</option>
              </select></label>
              <label>HTTP auth<select value={authScheme} onChange={(event) => setAuthScheme(event.target.value as HttpAuthScheme | "")} disabled={type === "SMTP"}>
                <option value="">All</option><option value="API_KEY">API key</option><option value="BEARER">Bearer</option><option value="BASIC">Basic</option><option value="CUSTOM_HEADERS">Custom headers</option>
              </select></label>
              <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All</option><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option><option value="REVOKED">Revoked</option>
              </select></label>
            </section>
            {connections.error && <ErrorMessage error={connections.error} onRetry={() => connections.refetch()} />}
            {error && <ErrorMessage error={error} />}
            <section className="panel stack">
              {connections.isLoading && <p className="muted">Loading connections...</p>}
              {!connections.isLoading && !connections.data?.length && <p className="muted">No connections match these filters.</p>}
              {!!connections.data?.length && (
                <table className="table">
                  <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Credential</th><th>Last test</th><th>Used by</th><th>Updated</th><th>Actions</th></tr></thead>
                  <tbody>
                    {connections.data.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <button type="button" className="link-button" onClick={() => setSelected(selected?.id === item.id ? null : item)}>{item.name}</button>
                          {item.description && <p className="muted">{item.description}</p>}
                          {selected?.id === item.id && <ConnectionDetail connection={item} canManage={canManageConnections(role)} onRename={(name) => updateConnection.mutate({ id: item.id, dto: { name } })} />}
                        </td>
                        <td>{item.type === "SMTP" ? "SMTP" : `HTTP ${item.authScheme ?? "API_KEY"}`}</td>
                        <td>{item.status}</td>
                        <td>{item.maskedCredential ?? item.credential}</td>
                        <td>{formatLastTest(item)}</td>
                        <td>{item.usageCount}</td>
                        <td>{formatDate(item.updatedAt)}</td>
                        <td>
                          <div className="workflow-actions">
                            <button type="button" onClick={() => setTest(item)}>Test</button>
                            {canManageConnections(role) && <button type="button" onClick={() => setRotate(item)}>Rotate</button>}
                            {canManageConnections(role) && <button type="button" onClick={() => setToggle(item)}>{item.status === "ACTIVE" ? "Disable" : "Enable"}</button>}
                            {canDeleteConnections(role) && <button type="button" onClick={() => setRemove(item)}>Delete</button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
      {createType && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Create connection">
            <h2>{createType === "HTTP" ? "HTTP" : "SMTP"} connection</h2>
            {createType === "HTTP" ? (
              <HttpConnectionForm pending={createConnection.isPending} onSubmit={create} onCancel={() => setCreateType(null)} />
            ) : (
              <SmtpConnectionForm pending={createConnection.isPending} onSubmit={create} onCancel={() => setCreateType(null)} />
            )}
          </section>
        </div>
      )}
      <RotateConnectionSecretDialog
        connection={rotate}
        pending={rotateConnection.isPending}
        onClose={() => setRotate(null)}
        onRotate={async (payload) => {
          if (rotate) await rotateConnection.mutateAsync({ id: rotate.id, ...payload });
          setRotate(null);
        }}
      />
      <TestConnectionDialog
        connection={test}
        pending={testConnection.isPending}
        result={testConnection.data}
        onClose={() => { setTest(null); testConnection.reset(); }}
        onTest={async (url) => {
          if (test) await testConnection.mutateAsync({ id: test.id, url });
        }}
      />
      <ConfirmDialog
        open={Boolean(toggle)}
        title={toggle?.status === "ACTIVE" ? "Disable connection" : "Enable connection"}
        description={toggle?.status === "ACTIVE" ? "Future workflow executions using this connection will fail until it is enabled again." : "Future workflow executions can use this connection again."}
        confirmLabel={toggle?.status === "ACTIVE" ? "Disable" : "Enable"}
        onCancel={() => setToggle(null)}
        onConfirm={async () => {
          if (toggle) {
            if (toggle.status === "ACTIVE") await disableConnection.mutateAsync(toggle.id);
            else await enableConnection.mutateAsync(toggle.id);
          }
          setToggle(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(remove)}
        title="Delete connection"
        description={remove?.usageCount ? "This connection is in use and cannot be deleted until workflows are migrated." : "This soft-deletes the connection and revokes the active secret."}
        confirmLabel="Delete"
        onCancel={() => setRemove(null)}
        onConfirm={async () => {
          if (remove) await deleteConnection.mutateAsync(remove.id);
          setRemove(null);
        }}
      />
    </RequireAuth>
  );
}

function ConnectionDetail({ connection, canManage, onRename }: { connection: ConnectionSummary; canManage: boolean; onRename: (name: string) => void }) {
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      {canManage && <label>Name<input defaultValue={connection.name} onBlur={(event) => event.target.value !== connection.name && onRename(event.target.value)} /></label>}
      <p className="muted">Created {formatDate(connection.createdAt)}{connection.rotatedAt ? ` · Rotated ${formatDate(connection.rotatedAt)}` : ""}</p>
      {!!connection.usage?.length && (
        <ul>
          {connection.usage.map((usage) => <li key={`${usage.workflowVersionId}:${usage.stepKey}`}>{usage.workflowName} v{usage.versionNumber} · {usage.stepName}</li>)}
        </ul>
      )}
    </div>
  );
}

function formatLastTest(connection: ConnectionSummary) {
  if (!connection.lastTest) return "Never";
  return `${connection.lastTest.status}${connection.lastTest.statusCode ? ` ${connection.lastTest.statusCode}` : ""} · ${formatDate(connection.lastTest.testedAt)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
