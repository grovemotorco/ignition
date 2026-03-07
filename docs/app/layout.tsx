import { RootProvider } from "fumadocs-ui/provider/next"
import "./global.css"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import type { Metadata } from "next"

/** Global metadata for the documentation site. */
export const metadata: Metadata = {
  title: {
    default: "Ignition",
    template: "%s | Ignition",
  },
  description:
    "Server automation in TypeScript. Write recipes as functions and push them over SSH.",
  openGraph: {
    type: "website",
    siteName: "Ignition",
    url: "https://ignition.sh",
    images: [{ url: "https://ignition.sh/og.png", width: 1200, height: 630, type: "image/png" }],
  },
  twitter: {
    card: "summary_large_image",
    images: ["https://ignition.sh/og.png"],
  },
  metadataBase: new URL("https://ignition.sh"),
}

/** Root app layout for the documentation site. */
export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${GeistSans.className} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  )
}
