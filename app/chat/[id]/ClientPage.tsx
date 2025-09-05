"use client";

import { type ComponentType, use, useEffect, useRef, useState } from "react";
import {
  Thread,
  useThread,
  ThreadWelcome as AUIThreadWelcome,
  AssistantMessage as AUIAssistantMessage,
  UserMessage as AUIUserMessage,
  useAssistantRuntime,
  MessagePrimitive,
} from "@assistant-ui/react";
import { makeMarkdownText } from "@assistant-ui/react-markdown";
import { Button } from "@/components/ui/button";
import { ImageViewer } from "@/components/ui/image-viewer";
import { ChevronsDown } from "lucide-react";
import { PriceSnapshotTool } from "@/components/tools/price-snapshot/PriceSnapshotTool";
import { PurchaseStockTool } from "@/components/tools/purchase-stock/PurchaseStockTool";
import { ToolFallback } from "@/components/tools/ToolFallback";
import { updateDraftAndHistory, getRepo, saveRepo, getMessages } from "@/lib/chatHistory";
import { useThreadRuntime } from "@assistant-ui/react";
import { createPortal } from "react-dom";
import CustomComposer from "@/components/layout/CustomComposer";

// 自定义图片组件，支持缩略图和点击查看大图
const CustomImage = ({ src, alt }: { src: string; alt?: string }) => {
  console.log('CustomImage rendered:', { src, alt });
  // 若是后端原图 /uploads/images/img_*.ext，则推导缩略图 /uploads/thumbnails/img_*_thumb.jpg
  let thumb: string | undefined = undefined;
  try {
    const url = new URL(src, typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
    const match = url.pathname.match(/\/uploads\/images\/(img_[a-z0-9]+)\.[a-z0-9]+$/i);
    if (match) {
      thumb = `${url.origin}/uploads/thumbnails/${match[1]}_thumb.jpg`;
    }
  } catch {}
  return <ImageViewer src={src} alt={alt} thumbnailUrl={thumb} />;
};


const MarkdownText = makeMarkdownText({
  className: "w-full max-w-full",
  style: { maxWidth: "100%", width: "100%" },
  components: {
    img: CustomImage,
  }
} as any);

// Normalize image URL: if relative '/uploads/...', point to backend (3001) origin
const normalizeImageSrc = (src?: string): string | undefined => {
  if (!src) return undefined;
  try {
    // already absolute
    if (/^https?:\/\//i.test(src)) return src;
    const isUploads = src.startsWith('/uploads/');
    const { protocol, hostname } = window.location;
    if (isUploads) {
      const backend = `${protocol}//${hostname}:3001`;
      return `${backend}${src}`;
    }
    // fallback to same-origin
    return new URL(src, window.location.origin).href;
  } catch {
    return src;
  }
};

// 将附件图片置于文本气泡上方
const CustomAttachment = ({ attachment }: { attachment: any }) => {
  try {
    if (attachment?.type === "image") {
      // 优先使用上传返回的 url，其次查找 content 中的 image 信息
      const raw =
        (attachment as any)?.url ||
        (attachment?.content?.find((c: any) => c?.type === "image")?.image ?? undefined);
      const src = normalizeImageSrc(
        typeof raw === "string" ? raw : raw?.url || raw?.thumb_url,
      );
      if (src) {
        return (
          <div className="mb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={attachment?.name || "Image"}
              className="rounded-lg border border-border cursor-pointer hover:opacity-80 transition-opacity"
              style={{
                minWidth: "250px",
                minHeight: "150px",
                maxWidth: "400px",
                maxHeight: "300px",
                width: "auto",
                height: "auto",
                objectFit: "contain",
              }}
              onClick={() => window.open(src, "_blank")}
            />
          </div>
        );
      }
    }
  } catch {}
  return (
    <div className="mb-2 p-2 border rounded bg-muted text-sm text-muted-foreground">
      📎 {attachment?.name || "Attachment"}
    </div>
  );
};

// 自定义的用户消息：图片附件在上，文本内容在下
function CustomUserMessage() {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Attachments components={{ Attachment: CustomAttachment }} />
      <div className="bg-muted rounded-lg px-4 py-2">
        <MessagePrimitive.Content
          components={{ Image: () => null, Text: MarkdownText as any }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function ContentDisclaimer() {
  return (
    <div className="mt-1 mb-3 px-4 text-center text-[11px] text-muted-foreground/80 select-none">
      我也可能会犯错，请核查重要信息
    </div>
  );
}

export default function ClientPage({ params, initialHasHistory }: { params: Promise<{ id: string }>; initialHasHistory: boolean; }) {
  const [isChatting, setIsChatting] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const chatContainerRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [composerHost, setComposerHost] = useState<HTMLElement | null>(null);
  const [centerHost, setCenterHost] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const BUFFER_PX = 24;
  const [preloadedMessages, setPreloadedMessages] = useState<any[]>([]);
  const initialPendingMessageRef = useRef<string | null>(null);
  const hasSentInitialRef = useRef(false);

  const getComposerHeight = () => {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--composer-h");
      const n = parseInt((raw || "").trim() || "0", 10);
      return Number.isFinite(n) && n > 0 ? n : 96;
    } catch {
      return 96;
    }
  };

  const scrollToBottomWithOffset = (behavior: ScrollBehavior = "smooth") => {
    try {
      const container = chatContainerRef.current;
      if (!container) return;
      const offset = getComposerHeight() + BUFFER_PX;
      const targetTop = container.scrollHeight - container.clientHeight - offset;
      container.scrollTo({ top: Math.max(targetTop, 0), behavior });
    } catch {}
  };

  // 监听消息长度变化，控制isChatting状态
  const messages = useThread((t) => t.messages);
  useEffect(() => {
    setIsChatting((messages as any[])?.length > 0);
  }, [messages]);

  // 恢复观察者包装器，确保props正确传递
  const withObserver = (Component: any) => {
    const Wrapped = (props: any) => <Component {...props} />;
    Wrapped.displayName = Component.displayName || Component.name || "Observed";
    return Wrapped;
  };

  const ObservedThreadWelcome = withObserver(AUIThreadWelcome);
  const ObservedAssistantMessage = withObserver(AUIAssistantMessage);
  const ObservedUserMessage = withObserver(AUIUserMessage);

  // 强制 Thread 在会话切换时重建
  const { id } = use(params);

  // URL 参数：欢迎态传递的消息（不立即发送）
  useEffect(() => {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const pendingMessage = urlParams.get('message');
      if (pendingMessage && pendingMessage.trim()) {
        initialPendingMessageRef.current = pendingMessage;
        window.history.replaceState({}, '', `/chat/${id}`);
      }
    } catch {}
  }, [id]);

  // 预加载历史消息
  useEffect(() => {
    (async () => {
      try {
        let msgs: any[] = [];
        try {
          const resp = await fetch(`/api/messages?conversationId=${id}`);
          if (resp.ok) {
            const data = await resp.json();
            msgs = Array.isArray(data?.items) ? data.items : [];
          }
        } catch {}
        if (msgs.length === 0) {
          const repo = getRepo(id);
          if (repo && Array.isArray(repo.messages)) {
            msgs = repo.messages.map(m => m.message);
          }
        }
        setPreloadedMessages(msgs);
        setIsChatting(msgs.length > 0);
      } catch {}
    })();
  }, [id]);

  // 导入与持久化
  const runtime = useThreadRuntime();
  useEffect(() => {
    try {
      if (!runtime) return;
      if (hasSentInitialRef.current) return;
      const pending = initialPendingMessageRef.current;
      if (!pending || !pending.trim()) return;
      const message = { id: `msg_${Date.now()}`, type: 'human', content: [{ type: 'text', text: pending }] } as any;
      (runtime as any).append?.(message);
      hasSentInitialRef.current = true;
    } catch {}
  }, [runtime]);
  useEffect(() => { try { updateDraftAndHistory(id, messages as any[]); if (runtime) saveRepo(id, runtime.export() as any); } catch {} }, [id, messages, runtime]);

  // 绑定 portal 宿主
  useEffect(() => { try { const el = document.getElementById("composer-host"); if (el) setComposerHost(el); } catch {} }, []);
  useEffect(() => { try { const el = document.getElementById("composer-host-center"); if (el) setCenterHost(el); } catch {} }, []);

  // 滚动容器/底部哨兵
  useEffect(() => {
    try {
      const start = rootRef.current as HTMLElement | null; let node = start?.parentElement ?? null; let found: HTMLElement | null = null;
      while (node) { const style = window.getComputedStyle(node); if ((style.overflowY === "auto" || style.overflowY === "scroll")) { found = node as HTMLElement; break; } node = node.parentElement; }
      if (found) { chatContainerRef.current = found; setScrollContainer(found); }
    } catch {}
  }, []);
  useEffect(() => {
    try { if (!endRef.current) return; const observer = new IntersectionObserver((entries) => { const entry = entries[0]; setIsNearBottom(entry?.isIntersecting ?? true); }, { threshold: 0.01, root: scrollContainer as Element | null }); observer.observe(endRef.current); return () => observer.disconnect(); } catch {}
  }, [endRef, scrollContainer]);

  // 预加载静态渲染（有历史）
  function PreloadedMessages() {
    if (preloadedMessages.length === 0) return null;
    return (
      <div className="space-y-4">
        {preloadedMessages.map((msg, idx) => {
          const role = (msg?.role || "").toString().toLowerCase();
          const isUser = role === "user" || role === "human";
          // 处理不同格式的消息内容
          let content = "";
          if (typeof msg.content === "string") {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            // 处理数组格式的内容（如图片+文本）
            const textParts = msg.content.filter(item => item.type === 'text');
            if (textParts.length > 0) {
              content = textParts[0].text;
            }
          } else if (msg.content?.text) {
            content = msg.content.text;
          } else {
            content = JSON.stringify(msg.content);
          }
          return (
            <div key={msg.id || idx} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-4 py-2 ${isUser ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-900'}`}>
                <div className="whitespace-pre-wrap">{content}</div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (preloadedMessages.length > 0) {
    return (
      <div className="flex h-full flex-col" ref={rootRef}>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="w-full h-full px-6 md:px-10 lg:px-14 mx-auto" style={{ paddingBottom: "var(--composer-h, 96px)", maxWidth: "var(--chat-max-w)" }}>
            <div className="py-8"><PreloadedMessages /></div>
            <div className="-mx-14 px-14">
              <Thread
                key={id}
                welcome={{ message: null, suggestions: [] }}
                assistantMessage={{ components: { ToolFallback } }}
                tools={[PriceSnapshotTool, PurchaseStockTool]}
                components={{ 
                  Composer: () => null, 
                  ThreadWelcome: () => null, 
                  AssistantMessage: ObservedAssistantMessage, 
                  UserMessage: ObservedUserMessage 
                }}
              />
            </div>
            <div ref={endRef} aria-hidden className="h-1" />
          </div>
        </div>
        {composerHost && createPortal(<><CustomComposer /><ContentDisclaimer /></>, composerHost)}
      </div>
    );
  }

  // 欢迎态只在确认为“无历史”时呈现
  const isEmpty = ((messages as any[])?.length || 0) === 0;
  if (!initialHasHistory && !isChatting && isEmpty) {
    return (
      <div className="flex h-full flex-col" ref={rootRef}>
        <div className="flex h-full flex-col items-center justify-center">
          <div className="w-full text-center space-y-12 px-6 md:px-10 lg:px-14">
            <div className="mx-auto max-w-2xl">
              <h1 className="text-2xl md:text-3xl font-medium text-foreground">我们先从哪里开始呢？</h1>
            </div>
          </div>
          <div className="w-full">
            <div className="mx-auto w-full px-6 md:px-10 lg:px-14 py-3" style={{ maxWidth: "calc((var(--chat-max-w) + 2 * 3.5rem) * 6/7)" }}>
              <div id="composer-host-center" />
              {centerHost && createPortal(<CustomComposer />, centerHost)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" ref={rootRef}>
      <div className="flex-1 min-h-0">
        <div className="w-full h-full px-6 md:px-10 lg:px-14 mx-auto" style={{ paddingBottom: "var(--composer-h, 96px)", maxWidth: "var(--chat-max-w)" }}>
          <div className="-mx-14 px-14">
            <Thread
              key={id}
              welcome={{ message: null, suggestions: [] }}
              assistantMessage={{ components: { ToolFallback } }}
              tools={[PriceSnapshotTool, PurchaseStockTool]}
              components={{ 
                Composer: () => null, 
                ThreadWelcome: () => null, 
                AssistantMessage: ObservedAssistantMessage, 
                UserMessage: CustomUserMessage 
              }}
            />
          </div>
          <div ref={endRef} aria-hidden className="h-1" />
        </div>
      </div>
      {composerHost && createPortal(<><CustomComposer /><ContentDisclaimer /></>, composerHost)}
      {!isNearBottom && (
        <div className="fixed right-6 bottom-24">
          <Button type="button" onClick={() => scrollToBottomWithOffset()} className="rounded-full shadow-md pl-3 pr-3 h-10" aria-label="回到最新">
            <ChevronsDown className="h-5 w-5 mr-2" /> 回到最新
          </Button>
        </div>
      )}
    </div>
  );
}


