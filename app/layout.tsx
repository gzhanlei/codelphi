import type { Metadata } from "next";
import { IcpFooter } from "@/components/icp-footer";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CoDelphi", template: "%s · CoDelphi" },
  description: "把 GitHub 代码变更翻译成带证据的发布说明与回归范围，采纳前经人工核实",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <IcpFooter />
      </body>
    </html>
  );
}
