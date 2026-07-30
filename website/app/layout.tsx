import type { Metadata } from "next";
import "@fontsource-variable/space-grotesk/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";

const publicSiteUrl =
  "https://kyooosukedn.github.io/codex-claude-bridge";

export const metadata: Metadata = {
  title: "Codex Claude Bridge",
  description:
    "Use Codex to send, inspect, steer, and answer prompts in persistent Claude Code sessions on your workstation.",
  metadataBase: new URL(publicSiteUrl),
  openGraph: {
    title: "Codex Claude Bridge",
    description:
      "Let Codex return to the Claude Code session already running on your workstation.",
    type: "website",
    images: [
      {
        url: `${publicSiteUrl}/og.png`,
        width: 1200,
        height: 630,
        alt: "Codex and Claude Code connected through a session-lock relay",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Codex Claude Bridge",
    description:
      "Let Codex return to the Claude Code session already running on your workstation.",
    images: [`${publicSiteUrl}/og.png`],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
