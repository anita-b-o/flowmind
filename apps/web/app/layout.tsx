import "./globals.css";
import "@xyflow/react/dist/style.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthProvider } from "../features/auth/auth-provider";
import { QueryProvider } from "../lib/query-provider";
import { AppFrame } from "../components/app-shell";

export const metadata: Metadata = {
  title: { default: "FlowMind", template: "%s · FlowMind" },
  description: "Build, operate and understand reliable workflows."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <AuthProvider><AppFrame>{children}</AppFrame></AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
