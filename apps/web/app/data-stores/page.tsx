"use client";

import { useState } from "react";
import { JsonViewer } from "../../components/json-viewer";
import { Pagination } from "../../components/pagination";
import { canManageDataStores } from "../../features/auth/rbac";
import { useAuth } from "../../features/auth/use-auth";
import {
  useCreateDataStore,
  useDataStoreRecords,
  useDataStores,
  useDeleteDataStore,
  useDeleteDataStoreRecord,
  useUpdateDataStore
} from "../../features/data-stores/hooks";
import type { DataStoreSummary } from "../../features/data-stores/types";

export default function DataStoresPage() {
  const auth = useAuth();
  const role = auth.organizations.find((organization) => organization.id === auth.activeOrganizationId)?.role;
  const stores = useDataStores();
  const createStore = useCreateDataStore();
  const updateStore = useUpdateDataStore();
  const deleteStore = useDeleteDataStore();
  const [selected, setSelected] = useState<DataStoreSummary | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const records = useDataStoreRecords(selected?.id, page, q);
  const deleteRecord = useDeleteDataStoreRecord(selected?.id);

  if (!canManageDataStores(role)) {
    return (
      <main className="content stack">
        <h1>Data Stores</h1>
        <section className="panel">You do not have permission to manage Data Stores.</section>
      </main>
    );
  }

  return (
    <main className="content stack">
      <div className="page-header">
        <div>
          <h1>Data Stores</h1>
          <p className="muted">Persistent workflow state scoped to this organization.</p>
        </div>
      </div>

      <section className="panel stack">
        <h2>Create Data Store</h2>
        <div className="workflow-form-grid">
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>
        <button type="button" disabled={!name.trim() || createStore.isPending} onClick={() => createStore.mutate({ name, description }, { onSuccess: (store) => { setSelected(store); setName(""); setDescription(""); } })}>
          Create
        </button>
      </section>

      <div className="debugger-grid">
        <section className="panel stack">
          <h2>Stores</h2>
          {stores.isLoading && <p className="muted">Loading Data Stores...</p>}
          {stores.error && <p className="field-error">Could not load Data Stores.</p>}
          {stores.data?.length === 0 && <p className="muted">No Data Stores yet.</p>}
          {stores.data?.map((store) => (
            <button key={store.id} type="button" className="version-item" onClick={() => { setSelected(store); setPage(1); }}>
              <strong>{store.name}</strong>
              <span className="muted">{store.recordCount} records</span>
              <span>{store.description}</span>
            </button>
          ))}
        </section>

        <section className="panel stack">
          <h2>{selected ? selected.name : "Records"}</h2>
          {selected && (
            <>
              <div className="workflow-form-grid">
                <label>
                  Rename
                  <input defaultValue={selected.name} onBlur={(event) => event.target.value !== selected.name && updateStore.mutate({ id: selected.id, dto: { name: event.target.value } })} />
                </label>
                <label>
                  Search key
                  <input value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} />
                </label>
              </div>
              <button type="button" onClick={() => window.confirm(`Delete Data Store "${selected.name}"?`) && deleteStore.mutate(selected.id, { onSuccess: () => setSelected(null) })}>
                Delete Data Store
              </button>
              {records.isLoading && <p className="muted">Loading records...</p>}
              {records.error && <p className="field-error">Could not load records.</p>}
              {records.data?.items.length === 0 && <p className="muted">No records found.</p>}
              {records.data?.items.map((record) => (
                <div key={record.id} className="version-item">
                  <strong>{record.key}</strong>
                  <span className="muted">v{record.version}</span>
                  <JsonViewer value={record.value} />
                  <button type="button" onClick={() => window.confirm(`Delete record "${record.key}"?`) && deleteRecord.mutate(record.key)}>
                    Delete record
                  </button>
                </div>
              ))}
              {records.data && <Pagination page={records.data.page} pageSize={records.data.pageSize} total={records.data.total} onPageChange={setPage} />}
            </>
          )}
          {!selected && <p className="muted">Select a Data Store to inspect records.</p>}
        </section>
      </div>
    </main>
  );
}
