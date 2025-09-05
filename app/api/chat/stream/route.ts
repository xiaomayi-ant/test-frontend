import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { shouldUseVision, prepareVisionMessage, extractText } from "@/lib/messageAnalyzer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type UnknownRecord = Record<string, any>;

function pickConversationIdFromBody(body: UnknownRecord): string | null {
  const id = typeof body?.conversationId === "string" ? body.conversationId : null;
  return id && id.length > 0 ? id : null;
}

function pickThreadIdFromBody(body: UnknownRecord): string | null {
  const id = typeof body?.threadId === "string" ? body.threadId : null;
  return id && id.length > 0 ? id : null;
}

function getLangGraphApiBase(): string {
  const base = process.env["LANGGRAPH_API_URL"];
  if (!base) throw new Error("LANGGRAPH_API_URL is not configured");
  // 统一在尾部补 /api，避免目标服务需要前缀
  const trimmed = base.replace(/\/$/, "");
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function getLangChainApiKey(): string | undefined {
  return process.env["LANGCHAIN_API_KEY"] || undefined;
}

// 从 messages 中找最后一个用户消息（尽量宽松）
function findLastUserMessage(messages: any[]): any | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = (m?.role || m?.type || "").toString().toLowerCase();
    if (role === "user" || role === "human") return m;
  }
  return null;
}

function extractTextFromMessage(message: any): string | null {
  try {
    if (!message) return null;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const first = content.find((p) => typeof p?.text === "string")?.text;
      if (first) return String(first);
      return String(content.map((p) => p?.text || p?.content || "").join(" ").trim());
    }
    if (content && typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.content === "string") return content.content;
    }
  } catch {}
  return null;
}

export async function POST(req: NextRequest) {
  // 解析 body
  const body = (await req.json().catch(() => null)) as UnknownRecord | null;
  if (!body) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const conversationId = pickConversationIdFromBody(body);
  const threadId = pickThreadIdFromBody(body);
  const messages = Array.isArray(body?.messages) ? (body!.messages as any[]) : [];

  if (!conversationId) {
    return new Response(JSON.stringify({ error: "conversationId is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!threadId) {
    return new Response(JSON.stringify({ error: "threadId is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // 先插入用户消息（若有）
  try {
    const lastUser = findLastUserMessage(messages);
    if (lastUser) {
      await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId,
          role: "USER",
          content: lastUser,
        },
        select: { id: true },
      });

      // 立即更新会话的 updatedAt，并在需要时用用户文本设定标题
      try {
        const userText = extractTextFromMessage(lastUser);
        const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { title: true } });
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            updatedAt: new Date(),
            ...(userText && (conv?.title === "新聊天" || !conv?.title) ? { title: userText.slice(0, 40) } : {}),
          },
        });
      } catch {}

      // 通知前端侧栏刷新
      try {
        // 通过 Server-Sent Events 无法直接广播，这里仅在返回前一次性发个“刷新提示”注释行。
        // 侧栏同时实现了轮询/焦点刷新，可保证及时同步。
      } catch {}
    }
  } catch (e) {
    // 用户消息入库失败不应阻断主流程，但建议监控
    console.warn("[chat/stream] failed to persist user message:", e);
  }

  // 调用 LangGraph 流式接口
  const upstreamUrl = `${getLangGraphApiBase()}/threads/${encodeURIComponent(threadId)}/runs/stream`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = getLangChainApiKey();
  if (apiKey) headers["x-api-key"] = apiKey;

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ input: { messages } }),
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(JSON.stringify({ error: `Upstream error ${upstream.status}` }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  // 准备转发 SSE，同时在服务端累积助手文本
  let assistantText = "";
  let buffer = "";
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const reader = upstream.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);

          // 累积并解析 SSE 块，以便提取最终文本
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1 || (idx = buffer.indexOf("\r\n\r\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + (buffer[idx] === "\r" ? 4 : 2));
            const lines = block.split(/\r?\n/);
            let event: string | null = null;
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (!event) continue;
            const dataStr = dataLines.join("\n");
            if (!dataStr) continue;
            try {
              const parsed = JSON.parse(dataStr);
              // 兼容多种事件格式，取到“最终文本”
              if (event === "partial_ai" && Array.isArray(parsed) && parsed[0]?.content) {
                // 假定 partial_ai 携带的是完整内容，直接覆盖
                assistantText = String(parsed[0].content ?? "");
              } else if (event === "message" && parsed?.choices?.[0]?.delta?.content) {
                assistantText += String(parsed.choices[0].delta.content);
              } else if (event === "on_chain_end" && parsed?.output) {
                const out = typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output);
                assistantText = out; // 认为该输出即最终内容
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      } catch (e) {
        console.error("[chat/stream] upstream read error", e);
        try { controller.error(e as any); } catch {}
        return;
      } finally {
        try { reader.releaseLock(); } catch {}
      }

      // 流结束：写入助手消息并更新会话时间与 threadId；若会话无标题则用首条用户消息生成默认标题
      try {
        if (assistantText && assistantText.trim().length > 0) {
          await prisma.message.create({
            data: {
              id: randomUUID(),
              conversationId,
              role: "ASSISTANT",
              content: { type: "text", text: assistantText },
            },
            select: { id: true },
          });
        }
        // 读取会话与首条用户消息；若标题仍为默认或为空，则用首条文本设为标题
        const [conv, firstUserInDb] = await Promise.all([
          prisma.conversation.findUnique({ where: { id: conversationId }, select: { title: true } }),
          prisma.message.findFirst({
            where: { conversationId, role: "USER" },
            orderBy: { createdAt: "asc" },
            select: { content: true },
          }),
        ]);
        let newTitle: string | undefined;
        try {
          const t = extractTextFromMessage(firstUserInDb ? { content: (firstUserInDb as any).content } : null);
          if (t && t.trim().length > 0) newTitle = t.trim().slice(0, 40);
        } catch {}
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            updatedAt: new Date(),
            threadId,
            ...(newTitle && (conv?.title === "新聊天" || !conv?.title) ? { title: newTitle } : {}),
          },
        });
      } catch (e) {
        console.warn("[chat/stream] failed to persist assistant message/update conv:", e);
      }

      try { controller.close(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Transfer-Encoding": "chunked",
    },
  });
}


