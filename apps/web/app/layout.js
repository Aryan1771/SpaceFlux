import "./globals.css";

export const metadata = {
  title: "SpaceFlux",
  description: "Realtime room chat, pointers, and peer-to-peer file sharing.",
  manifest: "/manifest.json",
  themeColor: "#0b1020",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg"
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
