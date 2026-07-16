import "./globals.css";
import "@xyflow/react/dist/style.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AuthProvider } from "../features/auth/auth-provider";
import { QueryProvider } from "../lib/query-provider";

export const metadata: Metadata = {
  title: "Automation Platform",
  description: "AI workflow automation SaaS"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
