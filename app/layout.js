import "./globals.css";

export const metadata = {
  title: "The Public Changes",
  description: "A blank page that strangers build together, a few characters at a time.",
};

export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
