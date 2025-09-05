"use client";

import { type ReactNode, use, useEffect, useState } from "react";
import { MyRuntimeProvider } from "../../MyRuntimeProvider";

export default function ChatRouteLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [threadId, setThreadId] = useState<string | null>(null);
  
  // 获取 threadId 用作 key
  useEffect(() => {
    try { console.log('[LAYOUT] chat mount', { id }); } catch {}
    (async () => {
      try {
        const r = await fetch(`/api/conversations/${id}`);
        if (r.ok) {
          const info = await r.json();
          const tid = info?.threadId || null;
          setThreadId(tid);
          console.log(`[LAYOUT] Got threadId for key:`, tid);
        }
      } catch {
        // 如果获取失败，使用 conversationId 作为 key
        setThreadId(id);
      }
    })();
    return () => {
      try { console.log('[LAYOUT] chat unmount', { id }); } catch {}
    };
  }, [id]);
  
  if (!threadId) {
    return <div>Loading conversation...</div>;
  }
  
  // 使用 threadId 作为 key，确保每个不同的线程都有独立的 Provider 实例
  return <MyRuntimeProvider key={threadId} conversationId={id} threadId={threadId}>{children}</MyRuntimeProvider>;
}


