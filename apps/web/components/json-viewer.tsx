const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "xapikey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "secretvalue",
  "connectionsecret",
  "password",
  "smtppassword",
  "encryptedvalue",
  "ciphertext",
  "authtag",
  "iv",
  "encryptionkey"
]);
const MAX_JSON_CHARS = 100_000;

export function JsonViewer({ value }: { value: unknown }) {
  const serialized = JSON.stringify(redact(value), null, 2) ?? "";
  const isLarge = serialized.length > MAX_JSON_CHARS;
  const visible = isLarge ? `${serialized.slice(0, MAX_JSON_CHARS)}\n... truncated ...` : serialized;

  return (
    <pre className="json-viewer">
      {visible || "null"}
      {isLarge ? "\nContent was truncated for display." : ""}
    </pre>
  );
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, REDACTED_KEYS.has(key.toLowerCase().replace(/[-_]/g, "")) ? "[redacted]" : redact(entry)])
    );
  }
  return value;
}
