import "./globals.css";

export const metadata = {
  title: "SpaceFlux",
  description: "Realtime room chat, pointers, and peer-to-peer file sharing.",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
