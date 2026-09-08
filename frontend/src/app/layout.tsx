import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The one display face in the app — used sparingly (wordmark, empty
// states, dialog titles) to give the utility-heavy mono/sans grid some
// warmth, in keeping with the app's "signal in the dark" identity.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "NosChat — self-hosted chat",
  description:
    "A self-hosted chat platform. Clerk handles sign-in/sign-up; everything else — data, files, realtime — lives on your homelab.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#F0A868",
          colorBackground: "#1B1F27",
          colorForeground: "#E8EAED",
          colorMutedForeground: "#8B93A1",
          colorInput: "#12151A",
          colorInputForeground: "#E8EAED",
          colorBorder: "#2A2F3A",
          // 0.625rem matches the app's own --radius token (globals.css) —
          // one deliberate radius across the whole product, not a Clerk default.
          borderRadius: "0.625rem",
          fontFamily: "var(--font-geist-sans)",
        },
        elements: {
          // Two-tone surface + a soft warm-tinted shadow that echoes the page's
          // own ambient glow, plus a hairline top highlight for a real bevel
          // instead of a flat rectangle sitting on top of the backdrop.
          card: "relative overflow-hidden rounded-2xl border border-white/[0.06] bg-gradient-to-b from-[#1E232C] to-[#161A20] p-8 shadow-[0_0_0_1px_rgba(240,168,104,0.06),0_24px_60px_-20px_rgba(0,0,0,0.7),0_10px_30px_-10px_rgba(240,168,104,0.10)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent",
          header: "gap-1.5",
          headerTitle: "text-[#E8EAED] text-xl font-semibold tracking-tight",
          headerSubtitle: "text-[#8B93A1] text-sm leading-relaxed",

          // OAuth row renders as icon buttons (not the block variant) once
          // there's more than a couple providers — give them real button
          // chrome instead of leaving them as bare icons.
          socialButtonsBlockButton:
            "rounded-lg border border-[#2A2F3A] bg-[#12151A] text-[#E8EAED] transition-all duration-200 hover:border-[#F0A868]/40 hover:bg-[#171B22] hover:-translate-y-px",
          socialButtonsBlockButtonText: "text-[#E8EAED] text-sm font-medium",
          socialButtonsIconButton:
            "rounded-lg border border-[#2A2F3A] bg-[#12151A] transition-all duration-200 hover:border-[#F0A868]/40 hover:bg-[#171B22] hover:-translate-y-px hover:shadow-[0_4px_16px_-4px_rgba(240,168,104,0.25)]",

          // Divider fades at the edges instead of a flat solid line, and the
          // "or" label reads like the mono wordmark up top — same voice.
          dividerLine:
            "h-px bg-gradient-to-r from-transparent via-[#2A2F3A] to-transparent",
          dividerText:
            "font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]",

          formFieldLabel:
            "font-mono text-[10px] uppercase tracking-[0.15em] text-[#8B93A1]",
          formFieldInput:
            "rounded-lg border border-[#2A2F3A] bg-[#12151A]/80 text-[#E8EAED] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] transition-colors duration-150 placeholder:text-[#8B93A1]/50 focus:border-[#F0A868]/50 focus:ring-2 focus:ring-[#F0A868]/15",
          formFieldInputShowPasswordButton:
            "text-[#8B93A1] hover:text-[#E8EAED]",

          // The signature: a warm gradient fill with a glow that visually
          // rhymes with the page's own amber backdrop glow, plus real press
          // feedback instead of a flat color swap on hover.
          formButtonPrimary:
            "rounded-lg bg-gradient-to-b from-[#F3B57E] to-[#EB9A50] text-[#12151A] font-semibold shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-6px_rgba(240,168,104,0.45)] transition-all duration-150 hover:shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_10px_26px_-6px_rgba(240,168,104,0.6)] hover:-translate-y-px active:translate-y-0 active:shadow-[0_1px_0_rgba(255,255,255,0.15)_inset,0_4px_12px_-6px_rgba(240,168,104,0.4)]",

          footer: "border-t border-white/[0.06] mt-2 pt-6",
          footerActionText: "text-[#8B93A1] text-sm",
          footerActionLink:
            "text-[#F0A868] hover:text-[#F3B57E] font-medium transition-colors",
          identityPreviewEditButton: "text-[#F0A868]",

          // "Development mode" / "Secured by Clerk" area — turned into a
          // small status pill with a dot, echoing the green "online" pulse
          // in the NOSCHAT wordmark up top. Same visual language, not two
          // unrelated bits of UI.
          badge:
            "rounded-full border border-[#F0A868]/25 bg-[#F0A868]/[0.08] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[#F0A868] before:mr-1.5 before:inline-block before:h-1.5 before:w-1.5 before:rounded-full before:bg-[#F0A868] before:align-middle before:content-['']",
        },
      }}
    >
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
