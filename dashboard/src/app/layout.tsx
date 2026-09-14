import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Thor Dashboard — Control Your Discord Bot from the Web",
  description:
    "A Discord bot that's free for every server: moderation, tickets, a shop, leveling, automod. Configure it via slash commands or the Dyno-style web dashboard — one data source, two ways to control it.",
  keywords: ["Discord bot", "dashboard", "Thor", "free", "moderation", "Dyno alternative"],
  authors: [{ name: "dwisetyabudi15581" }],
  openGraph: {
    title: "Thor Dashboard",
    description: "A free Discord bot — full control via slash commands or the web dashboard.",
    siteName: "Thor Dashboard",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // className="dark": this app is ALWAYS dark (manual bg-zinc-950). Without
    // this class, the shadcn theme variables (:root) resolve to the LIGHT
    // theme — variant="outline" buttons get a WHITE background that swallows
    // bright zinc text (the "text hidden under a color" bug).
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-zinc-950 text-zinc-100`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
