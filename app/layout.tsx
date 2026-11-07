import type { Metadata } from "next";
import { IcpFooter } from "@/components/icp-footer";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CoDelphi", template: "%s · CoDelphi" },
  description: "从 GitHub 代码维护可追溯的产品规格与变更知识",
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
