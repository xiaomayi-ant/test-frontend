"use client";

import { Button } from "@/components/ui/button";
import { ChevronDown, Mic, MoreHorizontal } from "lucide-react";

export function Topbar() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background" style={{ borderColor: "hsl(240 5.9% 98%)" }}>
      <div className="flex items-center gap-3 px-4 py-3">
        {/* 左侧：模型选择（占位） */}
        <Button variant="ghost" className="font-semibold">
          ChatGPT 5 <ChevronDown className="ml-1 h-4 w-4" />
        </Button>

        {/* 中间：留空，让布局更简洁 */}
        <div className="flex-1" />

        {/* 右侧更多 */}
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-5 w-5" />
        </Button>
      </div>
    </header>
  );
}
