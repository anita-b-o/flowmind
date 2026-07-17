"use client";

export interface OneTimeSecret {
  token?: string;
  webhookUrl: string;
  signatureSecret?: string;
}

export function OneTimeSecretPanel({ secret, onClose }: { secret: OneTimeSecret | null; onClose: () => void }) {
  if (!secret) {
    return null;
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal panel stack" role="dialog" aria-modal="true" aria-label="Webhook token">
        <h2>Webhook token</h2>
        <p className="muted">This token is shown once. Store it now or rotate the trigger later.</p>
        <label className="stack">
          URL
          <input readOnly value={secret.webhookUrl} />
          <button type="button" onClick={() => copy(secret.webhookUrl)}>
            Copy URL
          </button>
        </label>
        {secret.token && (
          <label className="stack">
            Token
            <input readOnly value={secret.token} />
            <button type="button" onClick={() => copy(secret.token!)}>
              Copy token
            </button>
          </label>
        )}
        {secret.signatureSecret && (
          <label className="stack">
            Signature secret
            <input readOnly value={secret.signatureSecret} />
            <button type="button" onClick={() => copy(secret.signatureSecret!)}>
              Copy signature secret
            </button>
          </label>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </section>
    </div>
  );
}
