import "./globals.css";

export const metadata = {
  title: "SiteShare",
  description: "Realtime room chat, pointers, and peer-to-peer file sharing."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
