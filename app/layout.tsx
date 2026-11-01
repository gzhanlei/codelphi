import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Radar", template: "%s · Radar" },
  description: "Chandler 内部产品知识与变更中心",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
