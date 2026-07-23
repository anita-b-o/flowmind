export {};

declare global {
  interface Window {
    __FLOWMIND_RUNTIME_CONFIG__?: {
      publicApiUrl?: string;
    };
  }
}
