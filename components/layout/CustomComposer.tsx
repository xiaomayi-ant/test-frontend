"use client";

import { Mic, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Composer as UIComposer } from "@assistant-ui/react";

export function CustomComposer() {

  return (
    <UIComposer.Root className="aui-composer-root grid grid-cols-[auto_1fr_auto] items-center gap-0 [grid-template-areas:'attachments_attachments_attachments'_'leading_primary_trailing']">
      {/* 使用 Assistant-UI 内置的附件显示 */}
      <div className="[grid-area:attachments]">
        <UIComposer.Attachments />
      </div>

      {/* leading: 附件按钮 */}
      <div className="[grid-area:leading] relative">
        <UIComposer.AddAttachment
          accept="image/*"
          className="rounded-full w-8 h-8 text-foreground/80 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </UIComposer.AddAttachment>
      </div>

      {/* primary: 输入区 */}
      <div className="aui-composer-primary [grid-area:primary] min-h-9 flex items-start gap-2 text-left">
        <UIComposer.Input className="aui-composer-input w-full text-left flex-1 min-w-0" placeholder="" />
      </div>

      {/* trailing: 麦克风 + 发送 */}
      <div className="[grid-area:trailing] flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="mic"
          className="rounded-full w-8 h-8 text-foreground/80 hover:text-foreground"
        >
          <Mic className="h-4 w-4" />
        </Button>
        <UIComposer.Action />
      </div>
    </UIComposer.Root>
  );
}

export default CustomComposer;


