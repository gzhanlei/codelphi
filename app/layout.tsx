import type { Metadata } from "next";
import { IcpFooter } from "@/components/icp-footer";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CoDelphi", template: "%s · CoDelphi" },
  description: "Chandler 内部产品知识与变更中心",
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
