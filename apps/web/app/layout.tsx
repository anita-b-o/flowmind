import "./globals.css";
import "@xyflow/react/dist/style.css";
import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";
import { AuthProvider } from "../features/auth/auth-provider";
import { QueryProvider } from "../lib/query-provider";
import { AppFrame } from "../components/app-shell";

export const metadata: Metadata = {
  title: { default: "FlowMind", template: "%s · FlowMind" },
  description: "Build, operate and understand reliable workflows.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const demoFree = process.env.NEXT_PUBLIC_FLOWMIND_DEMO_FREE === "true";
  return (
    <html lang="en">
      <body>
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
        <QueryProvider>
          <AuthProvider>
            {demoFree ? (
              <div className="demo-banner" role="status">
                Portfolio demo: the first request may take up to 90 seconds. AI
                and email are simulated, and background processing pauses while
                the free runtime sleeps.
              </div>
            ) : null}
            <AppFrame>{children}</AppFrame>
          </AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
