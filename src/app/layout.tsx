import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "MiniMax H3 Studio",
  description:
    "Генерация видео со звуком через MiniMax H3 на локальном ComfyUI",
  icons: [{ rel: "icon", url: "/logo.svg", type: "image/svg+xml" }],
};

export const viewport: Viewport = {
  themeColor: "#1c1c20",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="dark-gray" enableSystem={false} themes={["dark", "dark-gray"]}>
          {/* (правка 61) тема «Аврора» удалена; (правка 98) светлая тоже —
              если одна из них сохранена в браузере, миграция на дефолтную
              серую тему до первого рендера — иначе next-themes наложит
              несуществующий класс и страница откроется без темы. */}
          <script
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var k='theme';var t=localStorage.getItem(k);if(t==='aurora'||t==='light'){localStorage.setItem(k,'dark-gray');var d=document.documentElement;d.classList.remove('aurora','light');d.classList.add('dark-gray');}}catch(e){}})();`,
            }}
          />
          {children}
        </ThemeProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
