import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR Dashboard",
  description: "Personal GitHub PR notification feed",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
