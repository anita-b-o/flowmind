import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { QueryProvider } from "../lib/query-provider";

export const metadata: Metadata = {
  title: "Automation Platform",
  description: "AI workflow automation SaaS"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
