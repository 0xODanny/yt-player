import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SettingsProvider } from "@/lib/settings";
import { ServiceWorkerRegistrar } from "./sw-register";
import { ViewportLock } from "./viewport-lock";

export const metadata: Metadata = {
  title: "YT Local Tool",
  description: "Local utility for downloading non-copyrighted YouTube and direct media URLs.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "YT Local Tool",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  minimumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0a0f17",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <ServiceWorkerRegistrar />
        <ViewportLock />
        <SettingsProvider>{children}</SettingsProvider>
      </body>
    </html>
  );
}