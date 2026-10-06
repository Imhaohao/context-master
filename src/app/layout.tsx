import type { Metadata } from 'next';
import '@fontsource-variable/ibm-plex-sans';
import './globals.css';
export const metadata: Metadata = { title: 'Context Master', description: 'Consult specialists built from your saved coding sessions.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="antialiased">{children}</body></html>;
}
