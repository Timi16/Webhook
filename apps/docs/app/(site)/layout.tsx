import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import '../global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: { default: 'Webhook docs', template: '%s | Webhook docs' },
  description: 'Payment webhooks for Stellar Testnet: watch a wallet, get a signed event when it is paid.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
