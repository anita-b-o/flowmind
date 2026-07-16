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
  useRevokeConnection,
  useRotateConnection,
  useTestConnection,
  useUpdateConnection
} from "../../features/connections/hooks";
import { HttpApiKeyConnectionForm, RotateConnectionSecretDialog, SmtpConnectionForm, TestConnectionDialog } from "../../features/connections/forms";
import type { ConnectionSummary, ConnectionType, CreateConnectionDto } from "../../features/connections/types";

export default function ConnectionsPage() {
  const [type, setType] = useState<ConnectionType | "">("");
  const [status, setStatus] = useState("");
  const [createType, setCreateType] = useState<ConnectionType | null>(null);
  const [rotate, setRotate] = useState<ConnectionSummary | null>(null);
  const [test, setTest] = useState<ConnectionSummary | null>(null);
  const [revoke, setRevoke] = useState<ConnectionSummary | null>(null);
  const [remove, setRemove] = useState<ConnectionSummary | null>(null);
  const connections = useConnections({ type, status });
  const createConnection = useCreateConnection();
  const updateConnection = useUpdateConnection();
  const rotateConnection = useRotateConnection();
  const revokeConnection = useRevokeConnection();
  const deleteConnection = useDeleteConnection();
  const testConnection = useTestConnection();
  const { organizations, activeOrganizationId } = useAuth();
  const role = organizations.find((organization) => organization.id === activeOrganizationId)?.role;

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
            <p className="muted">Credentials are encrypted and never shown after saving.</p>
          </div>
          {canManageConnections(role) && (
            <div className="workflow-actions">
              <button type="button" onClick={() => setCreateType("HTTP_API_KEY")}>New HTTP API key</button>
              <button type="button" onClick={() => setCreateType("SMTP")}>New SMTP</button>
            </div>
          )}
        </div>
        {!canListConnections(role) && <section className="panel">You do not have permission to view connections.</section>}
        {canListConnections(role) && (
          <>
            <section className="panel workflow-form-grid">
              <label>Type<select value={type} onChange={(event) => setType(event.target.value as ConnectionType | "")}>
                <option value="">All</option><option value="HTTP_API_KEY">HTTP API key</option><option value="SMTP">SMTP</option>
              </select></label>
              <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All</option><option value="ACTIVE">Active</option><option value="REVOKED">Revoked</option><option value="DISABLED">Disabled</option>
              </select></label>
            </section>
            {connections.error && <ErrorMessage error={connections.error} onRetry={() => connections.refetch()} />}
            {(createConnection.error || rotateConnection.error || revokeConnection.error || deleteConnection.error || testConnection.error || updateConnection.error) && (
              <ErrorMessage error={createConnection.error ?? rotateConnection.error ?? revokeConnection.error ?? deleteConnection.error ?? testConnection.error ?? updateConnection.error} />
            )}
            <section className="panel stack">
              {connections.isLoading && <p className="muted">Loading connections...</p>}
              {!connections.isLoading && !connections.data?.length && <p className="muted">No connections match these filters.</p>}
              {!!connections.data?.length && (
                <table className="table">
                  <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Credential</th><th>Updated</th><th>Actions</th></tr></thead>
                  <tbody>
                    {connections.data.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <input
                            disabled={!canManageConnections(role)}
                            value={item.name}
                            onChange={(event) => updateConnection.mutate({ id: item.id, dto: { name: event.target.value } })}
                          />
                          {item.description && <p className="muted">{item.description}</p>}
                        </td>
                        <td>{item.type}</td>
                        <td>{item.status}</td>
                        <td>{item.credential}</td>
                        <td>{formatDate(item.updatedAt)}</td>
                        <td>
                          <div className="workflow-actions">
                            <button type="button" onClick={() => setTest(item)}>Test</button>
                            {canManageConnections(role) && <button type="button" onClick={() => setRotate(item)}>Rotate</button>}
                            {canManageConnections(role) && item.status === "ACTIVE" && <button type="button" onClick={() => setRevoke(item)}>Revoke</button>}
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
            <h2>{createType === "HTTP_API_KEY" ? "HTTP API key" : "SMTP"} connection</h2>
            {createType === "HTTP_API_KEY" ? (
              <HttpApiKeyConnectionForm pending={createConnection.isPending} onSubmit={create} onCancel={() => setCreateType(null)} />
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
        onRotate={async (secretValue) => {
          if (rotate) await rotateConnection.mutateAsync({ id: rotate.id, secretValue });
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
        open={Boolean(revoke)}
        title="Revoke connection"
        description="Future workflow executions using this connection will fail until a new active connection is selected."
        confirmLabel="Revoke"
        onCancel={() => setRevoke(null)}
        onConfirm={async () => {
          if (revoke) await revokeConnection.mutateAsync(revoke.id);
          setRevoke(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(remove)}
        title="Delete connection"
        description="Connections used by active workflow versions cannot be deleted."
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

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
