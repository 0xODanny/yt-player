import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";

import "./globals.css";
import { SettingsProvider } from "@/lib/settings";
import { ServiceWorkerRegistrar } from "./sw-register";
import { ViewportLock } from "./viewport-lock";

const brandDisplay = DM_Sans({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-brand-display",
});

export const metadata: Metadata = {
  title: "Pepinho Player",
  description: "Ad-free music and video player with offline saves.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Pepinho Player",
    statusBarStyle: "default",
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
  themeColor: "#c2d884",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={brandDisplay.variable}>
      <body>
        <ServiceWorkerRegistrar />
        <ViewportLock />
        <SettingsProvider>{children}</SettingsProvider>
      </body>
    </html>
  );
}