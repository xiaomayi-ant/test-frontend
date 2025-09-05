"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { ChatUIContext } from "@/lib/chatUiContext";
import { AssistantRuntimeProvider, AttachmentAdapter, PendingAttachment, CompleteAttachment, useThreadRuntime } from "@assistant-ui/react";
import { useLangGraphRuntime, LangChainMessage } from "@assistant-ui/react-langgraph";
import { createThread, sendMessage, visionStream } from "@/lib/chatApi";

// 定义本地附件状态接口
interface LocalAttachment {
  id: string;
  type: "file" | "image" | "document";
  name: string;
  contentType: string;
  size: number;
  file: File;
  fileId?: string;
  url?: string;
  status: any; // 使用any来避免复杂的类型匹配
  createdAt: number;
  deleted?: boolean;
  fileContent?: string; // 新增：保存文件内容
}

export function MyRuntimeProvider({
  children,
  conversationId,
  threadId: propThreadId,
}: Readonly<{
  children: React.ReactNode;
  conversationId?: string;
  threadId?: string;
}>) {
  const runtimeIdRef = useRef<string>(`rt_${Math.random().toString(36).slice(2, 9)}`);
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]); // 本地状态管理附件
  const attachmentsRef = useRef<LocalAttachment[]>([]); // 使用ref来保存最新状态
  const [isUploading, setIsUploading] = useState(false); // 添加上传状态标志
  const isStreamingRef = useRef(false); // 添加流式处理状态标志
  // 使用传入的 threadId，如果没有则异步获取
  const [threadId, setThreadId] = useState<string | undefined>(propThreadId);
  
  useEffect(() => {
    if (propThreadId) {
      setThreadId(propThreadId);
      console.log(`[RT] Using prop threadId:`, propThreadId);
      return;
    }
    
    // 如果有 conversationId，异步获取对应的 threadId
    if (conversationId) {
      (async () => {
        try {
          const r = await fetch(`/api/conversations/${conversationId}`);
          if (r.ok) {
            const info = await r.json();
            if (typeof info?.threadId === "string" && info.threadId) {
              setThreadId(info.threadId);
              console.log(`[RT] threadId(async)`, { runtimeId: runtimeIdRef.current, threadId: info.threadId });
            }
          }
        } catch {}
      })();
    } else {
      // 首页场景：没有 conversationId，生成临时 threadId
      const tempThreadId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      setThreadId(tempThreadId);
      console.log(`[RT] Generated temp threadId for home:`, tempThreadId);
    }
  }, [conversationId, propThreadId]);

  // UI 状态：是否进入消息态（方案C：用上下文替代瞬时事件）
  const [uiIsChatting, setUiIsChatting] = useState(false);
  const [hasHomeReset, setHasHomeReset] = useState(false);

  // 规范化图片URL：相对路径 /uploads/... → http(s)://<host>:3001/uploads/...
  const normalizeImageSrc = (src?: string): string | undefined => {
    if (!src) return undefined;
    try {
      if (/^https?:\/\//i.test(src)) return src;
      if (src.startsWith('/uploads/')) {
        const { protocol, hostname } = window.location;
        return `${protocol}//${hostname}:3001${src}`;
      }
      return new URL(src, window.location.origin).href;
    } catch {
      return src;
    }
  };

  // 当进入首页（无 conversationId）时，确保重置为欢迎态
  useEffect(() => {
    try {
      if (!conversationId) {
        console.log(`[RT] reset uiIsChatting=false on home`, { runtimeId: runtimeIdRef.current });
        setUiIsChatting(false);
        setHasHomeReset(false);
      }
    } catch {}
  }, [conversationId]);

  // 首页：在 runtime 就绪后做一次 reset，清空旧消息，随后标记 hasHomeReset=true
  // 注意：依赖于下方声明的 runtime，因此将 effect 放在 runtime 声明之后

  // 状态追踪函数
  const logStateChange = (action: string, data: any) => {
    console.log(`[STATE] ${action}:`, data);
  };

  // 更新ref当attachments状态变化时
  const updateAttachmentsRef = (newAttachments: LocalAttachment[]) => {
    attachmentsRef.current = newAttachments;
    console.log(`[REF] 更新附件引用，当前数量: ${newAttachments.length}`);
  };

  const attachmentAdapter: AttachmentAdapter = {
    accept: "text/plain,application/pdf,image/*", // 限制安全类型

    // add 方法：预验证文件，生成 pending 元数据
    async add({ file }: { file: File }): Promise<PendingAttachment> {
      console.log(`[ADD] 开始添加文件: ${file.name}`);
      
      const allowedTypes = ["text/plain", "application/pdf", "image/jpeg", "image/png"];
      if (!allowedTypes.includes(file.type)) {
        throw new Error(`不支持的文件类型: ${file.type}`);
      }
      const maxSize = 10 * 1024 * 1024; // 10MB 上限
      if (file.size > maxSize) {
        throw new Error("文件大小超过 10MB");
      }
      
      const id = `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      // 根据文件类型，赋予更语义化的附件类型，便于内置 UI 使用合适的样式/图标
      const attachmentType = file.type.startsWith("image/")
        ? "image"
        : (file.type === "application/pdf" ? "document" : "file");

      const attachment: PendingAttachment = {
        id,
        type: attachmentType as any,
        name: file.name,
        contentType: file.type,
        file,
        status: { type: "requires-action", reason: "composer-send" },
      };
      
      // 创建本地附件状态
      const localAttachment: LocalAttachment = {
        ...attachment,
        size: file.size,
        createdAt: Date.now(),
      };
      
      setAttachments((prev) => {
        const newState = [...prev, localAttachment];
        logStateChange("添加文件", { id, name: file.name, totalCount: newState.length });
        updateAttachmentsRef(newState); // 更新ref
        return newState;
      });
      
      console.log(`[ADD] 文件添加成功: ${file.name}, ID: ${id}`);
      return attachment;
    },

    // send 方法：只负责文件上传，不发送消息
    async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
      console.log(`[SEND] 开始上传文件: ${attachment.name}`);
      
      // 设置上传状态
      setIsUploading(true);
      
      // 确保threadId存在
      if (!threadId) {
        console.log(`[SEND] 创建新线程`);
        const { thread_id } = await createThread();
        setThreadId(thread_id);
      }
      
      try {
        // 更新状态为 uploading，支持进度反馈
        setAttachments((prev) => {
          const newState = prev.map((a) => {
            if (a.id === attachment.id) {
              const updated = { ...a, status: { type: "uploading", progress: 0 } };
              logStateChange("开始上传", { id: a.id, name: a.name, progress: 0 });
              return updated;
            }
            return a;
          });
          updateAttachmentsRef(newState); // 更新ref
          return newState;
        });

        // 模拟进度更新
        const progressInterval = setInterval(() => {
          setAttachments((prev) => {
            const newState = prev.map((a) => {
              if (a.id === attachment.id && a.status.type === "uploading") {
                const newProgress = Math.min((a.status.progress || 0) + 25, 100);
                const updated = { ...a, status: { type: "uploading", progress: newProgress } };
                logStateChange("上传进度", { id: a.id, name: a.name, progress: newProgress });
                return updated;
              }
              return a;
            });
            updateAttachmentsRef(newState); // 更新ref
            return newState;
          });
        }, 300);

        let uploadResult: any;
        let completeAttachment: CompleteAttachment;

        if (attachment.contentType.startsWith("image/")) {
          // 图片文件：使用专门的图片API
          console.log(`[SEND] 图片文件，使用专门的API上传`);
          
          const formData = new FormData();
          formData.append("file", attachment.file);
          
          const response = await fetch("/api/images", {
            method: "POST",
            body: formData,
          });
          
          if (!response.ok) {
            throw new Error(`图片上传失败: ${response.statusText}`);
          }
          
          uploadResult = await response.json();
          clearInterval(progressInterval);
          
          console.log(`[SEND] 图片上传成功:`, uploadResult);

          // 构造包含完整图片元数据的 CompleteAttachment
          completeAttachment = {
            id: attachment.id,
            type: "image" as any,
            name: attachment.name,
            contentType: attachment.contentType,
            status: { type: "complete" },
            content: [{
              type: "image",
              image: {
                image_id: uploadResult.image_id,
                url: uploadResult.url,
                thumb_url: uploadResult.thumb_url,
                mime_type: uploadResult.meta?.mime || attachment.contentType,
                size: uploadResult.meta?.size || attachment.file.size,
              }
            }],
          };
        } else {
          // 非图片文件：使用常规上传API
          console.log(`[SEND] 非图片文件，使用常规API上传`);
          
          const formData = new FormData();
          formData.append("file", attachment.file);
          formData.append("threadId", threadId || "");
          
          const response = await fetch("/api/upload", {
            method: "POST",
            body: formData,
          });
          
          if (!response.ok) {
            throw new Error(`上传失败: ${response.statusText}`);
          }
          
          uploadResult = await response.json();
          clearInterval(progressInterval);
          
          console.log(`[SEND] 文件上传成功:`, uploadResult);

          // 读取文件内容（用于后续消息构造）
          let fileContent = "";
          try {
            if (attachment.contentType === "text/plain") {
              fileContent = await attachment.file.text();
              console.log(`[SEND] 读取文件内容成功，长度: ${fileContent.length}`);
            } else {
              fileContent = `[${attachment.contentType} 文件内容]`;
              console.log(`[SEND] 非文本文件，使用占位符`);
            }
          } catch (error) {
            console.warn(`[SEND] 读取文件内容失败:`, error);
            fileContent = `[无法读取文件内容: ${attachment.name}]`;
          }

          completeAttachment = {
            id: attachment.id,
            type: attachment.contentType === "application/pdf" ? "document" : "file",
            name: attachment.name,
            contentType: attachment.contentType,
            status: { type: "complete" },
            content: [
              { type: "text", text: `File: ${attachment.name} (${attachment.contentType})` },
            ],
          };
        }

        // 更新本地状态，保存文件内容和上传结果
        setAttachments((prev) => {
          const newState = prev.map((a) => {
            if (a.id === attachment.id) {
              const updated = { 
                ...a, 
                fileId: uploadResult.fileId || uploadResult.image_id, 
                url: uploadResult.url, 
                status: { type: "complete" },
                fileContent: attachment.contentType.startsWith("image/") ? "" : "" // 图片不需要文件内容
              };
              logStateChange("上传完成", { id: a.id, name: a.name, fileId: uploadResult.fileId || uploadResult.image_id });
              return updated;
            }
            return a;
          });
          updateAttachmentsRef(newState); // 更新ref
          return newState;
        });
        
        console.log(`[SEND] 文件上传完成: ${attachment.name}`);
        return completeAttachment;
      } catch (error: any) {
        console.error(`[SEND] 文件上传失败: ${attachment.name}`, error);
        
        setAttachments((prev) => {
          const newState = prev.map((a) => {
            if (a.id === attachment.id) {
              const updated = { ...a, status: { type: "requires-action", reason: error.message } };
              logStateChange("上传失败", { id: a.id, name: a.name, error: error.message });
              return updated;
            }
            return a;
          });
          updateAttachmentsRef(newState); // 更新ref
          return newState;
        });
        throw error;
      } finally {
        // 清除上传状态
        setIsUploading(false);
      }
    },

    // remove 方法：通知后端删除，更新状态，处理删除矛盾
    async remove(attachment: CompleteAttachment): Promise<void> {
      console.log(`[REMOVE] 开始删除文件: ${attachment.name}`);
      
      try {
        const localAttachment = attachments.find(a => a.id === attachment.id);
        const fileId = localAttachment?.fileId || attachment.id;
        const currentThreadId = threadId || "";
        
        console.log(`[REMOVE] 删除参数:`, { fileId, threadId, hasThreadId: !!threadId });
        
        // 使用真实API删除文件
        const response = await fetch(`/api/files/${fileId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId: currentThreadId }),
        });
        
        if (!response.ok) {
          console.warn(`[REMOVE] 删除文件API返回错误: ${response.status}`);
          // 不抛出错误，继续执行本地状态清理
        }
        
        // 直接更新本地状态，移除对不存在端点的调用
        setAttachments((prev) => {
          const newState = prev.filter((a) => a.id !== attachment.id);
          updateAttachmentsRef(newState);
          logStateChange("删除文件", { id: attachment.id, name: attachment.name, remainingCount: newState.length });
          return newState;
        });
        
        console.log(`[REMOVE] 文件删除完成: ${attachment.name}`);
      } catch (error) {
        console.error(`[REMOVE] 文件删除失败: ${attachment.name}`, error);
        
        // 即使删除失败，也要清理本地状态
        setAttachments((prev) => {
          const newState = prev.filter((a) => a.id !== attachment.id);
          updateAttachmentsRef(newState);
          return newState;
        });
        
        // 不抛出错误，避免界面崩溃
        console.log(`[REMOVE] 已清理本地状态，忽略删除错误`);
      }
    },
  };

  // 移除 useThreadRuntime，我们将使用不同的方法
  
  const runtime = useLangGraphRuntime({
    threadId: threadId,
    stream: async (messages: LangChainMessage[]) => {
      // 防止重复调用
      if (isStreamingRef.current) {
        console.log(`[STREAM] 检测到重复调用，跳过`);
        // 返回一个空的异步生成器
        return (async function* () {
          yield { event: "error", data: { error: "重复调用被跳过" } };
        })();
      }
      
      isStreamingRef.current = true;
      console.log(`[STREAM] 开始处理消息，消息数量: ${messages.length}`);
      console.log(`[STREAM] Using threadId:`, threadId);
      try { console.log(`[STREAM] runtime pre-export len`, (runtime as any)?.export?.()?.messages?.length); } catch {}
      
      // 首页场景：不再派发 DOM 事件，直接通过上下文切换 UI
      if (!conversationId) {
        try { setUiIsChatting(true); console.log(`[RT] uiIsChatting=true by stream start on home`); } catch {}
      }
      
      try {
        // threadId 现在由 layout 层传入，不需要在这里获取
        let currentThreadId = threadId;
        if (!currentThreadId) {
          const { thread_id } = await createThread();
          currentThreadId = thread_id;
          console.log(`[RT] Created new threadId:`, currentThreadId);
        }

        // 如果有文件正在上传，等待上传完成
        if (isUploading) {
          console.log(`[STREAM] 检测到文件正在上传，等待完成...`);
          let waitCount = 0;
          while (isUploading && waitCount < 50) { // 最多等待5秒
            await new Promise(resolve => setTimeout(resolve, 100));
            waitCount++;
          }
          console.log(`[STREAM] 等待上传完成，等待次数: ${waitCount}`);
        }

        // 处理 langchain/langgraph-sdk的流式响应转换为@assistant-ui/react-langgraph期望的格式
        const convertToLangGraphFormat = async function* (streamResponse: any) {
          try {
            let hasYieldedContent = false;
            let chunkCount = 0;
            let accumulatedContent = ""; // 累积Python后端的内容
            let currentMessageId = `msg_${Date.now()}`; // 当前消息ID
            console.log(`[STREAM] 开始处理流式响应...`);
            
            for await (const chunk of streamResponse) {
              chunkCount++;
              console.log(`[STREAM] 处理chunk ${chunkCount}:`, chunk);
              
              // 修改：处理新事件类型，并映射到前端期望的 'messages/partial' 和 'messages/complete'
              if (chunk && typeof chunk === 'object') {
                console.log(`[STREAM] 处理事件类型: ${chunk.event}`);
                
                // 处理Python后端发送的partial_ai事件（与TypeScript后端一致）
                if (chunk.event === 'partial_ai' && chunk.data && Array.isArray(chunk.data)) {
                  hasYieldedContent = true;
                  
                  // 修改：Python后端发送的是完整内容，直接使用
                  if (chunk.data.length > 0 && chunk.data[0].content) {
                    // 使用后端发送的完整内容
                    accumulatedContent = chunk.data[0].content;
                    
                    // 使用后端提供的消息ID，如果没有则使用默认ID
                    const messageId = chunk.data[0].id || currentMessageId;
                    
                    // 确保消息ID一致，这样Assistant UI就能正确更新现有消息
                    const messagesWithId = [{
                      id: messageId,
                      type: 'ai',
                      content: accumulatedContent // 发送完整内容
                    }];
                    
                    console.log(`[STREAM] 发送partial_ai事件，消息ID: ${messageId}, 内容长度: ${accumulatedContent.length}`);
                    yield { event: 'messages/partial', data: messagesWithId };
                  }
                } else if (chunk.event === 'tool_result' && chunk.data && Array.isArray(chunk.data)) {
                  // 映射 tool_result 到 messages/partial，并转换为 ai 类型
                  hasYieldedContent = true;
                  const toolMessages = chunk.data.map((msg: any, index: number) => {
                    if (msg.type === 'tool') {
                      // 将工具结果转换为AI消息
                      console.log(`[STREAM] 转换工具消息为AI消息:`, msg);
                      return {
                        id: msg.id || `tool_${Date.now()}_${index}`,
                        type: 'ai',  // 转换为ai类型
                        content: msg.content
                      };
                    }
                    return {
                      ...msg,
                      id: msg.id || `tool_${Date.now()}_${index}`
                    };
                  });
                  yield { event: 'messages/partial', data: toolMessages };
                } else if (chunk.event === 'message' && chunk.data) {
                  // 处理OpenAI格式的聊天完成响应（兼容性）
                  const data = chunk.data;
                  if (data.choices && data.choices.length > 0) {
                    const choice = data.choices[0];
                    if (choice.delta && choice.delta.content) {
                      // 有内容更新，累积内容并发送完整内容
                      hasYieldedContent = true;
                      const deltaContent = choice.delta.content;
                      accumulatedContent += deltaContent;
                      yield { event: 'messages/partial', data: [{ 
                        id: currentMessageId,
                        type: 'ai', 
                        content: accumulatedContent  // 发送累积内容，不是增量内容
                      }] };
                    } else if (choice.finish_reason === 'stop') {
                      // 响应完成
                      yield { event: 'messages/complete', data: [] };
                    }
                  }
                } else if (chunk.event === 'error') {
                  // 显示上游错误为一条AI消息
                  hasYieldedContent = true;
                  const errData: any = chunk.data;
                  const msg =
                    (errData && (errData.error?.message || errData.message))
                      ? (errData.error?.message || errData.message)
                      : (typeof errData === 'string' ? errData : JSON.stringify(errData));
                  yield { event: 'messages/partial', data: [{ 
                    id: `msg_${Date.now()}_error`,
                    type: 'ai', 
                    content: `图片识别出错：${msg}`
                  }] };
                } else if (chunk.event === 'done') {
                  // 兼容 [DONE] 结束事件
                  yield { event: 'messages/complete', data: [] };
                } else if (chunk.event === 'complete') {
                  // 映射 complete 到 messages/complete
                  yield { event: 'messages/complete', data: [] };
                } else if (chunk.event === 'on_tool_end') {
                  // 处理工具执行完成事件
                  hasYieldedContent = true;
                  yield { event: 'messages/partial', data: [{ 
                    id: `tool_end_${Date.now()}`,
                    type: 'ai', 
                    content: chunk.data?.message || '工具执行完成'
                  }] };
                } else if (chunk.event === 'on_chain_end') {
                  // 处理链事件
                  console.log(`[STREAM] 处理链事件:`, chunk);
                  if (chunk.data && chunk.data.output) {
                    hasYieldedContent = true;
                    yield { event: 'messages/partial', data: [{ 
                      id: `msg_${Date.now()}_tool`,
                      type: 'ai', 
                      content: typeof chunk.data.output === "string" ? chunk.data.output : JSON.stringify(chunk.data.output)
                    }] };
                  }
                } else if (chunk.event && chunk.data) {
                  // 其他事件，直接传递
                  yield chunk;
                } else {
                  console.warn(`[STREAM] 未知chunk格式:`, chunk);
                }
              } else {
                console.warn(`[STREAM] 无效chunk:`, chunk);
              }
            }
            
            console.log(`[STREAM] 流式响应处理完成，总chunk数: ${chunkCount}, 是否有内容: ${hasYieldedContent}`);
            
            // 如果没有收到任何内容，发送一个默认响应
            if (!hasYieldedContent) {
              console.log(`[STREAM] 没有收到内容，发送默认响应`);
              yield { event: 'messages/partial', data: [{ 
                id: `msg_${Date.now()}_default`,
                type: 'ai', 
                content: '正在处理您的请求...' 
              }] };
              yield { event: 'messages/complete', data: [] };
            }
          } catch (error) {
            console.error(`[STREAM] 流式响应处理错误:`, error);
            yield { event: 'messages/partial', data: [{ type: 'ai', content: '处理过程中出现错误，请重试。' }] };
            yield { event: 'messages/complete', data: [] };
          }
        };

        // 检查是否有附件需要处理，包括图片和文档文件
        console.log(`[STREAM] 附件引用状态检查:`, {
          attachmentsRefLength: attachmentsRef.current?.length || 0,
          attachmentsRef: attachmentsRef.current
        });
        
        const completedAttachments = attachmentsRef.current.filter(a => a.status.type === "complete");
        
        console.log(`[STREAM] 当前附件状态:`, attachmentsRef.current.map(a => ({
          id: a.id,
          name: a.name,
          status: a.status.type,
          contentType: a.contentType,
          fileId: a.fileId,
          hasUrl: !!a.url
        })));
        
        console.log(`[STREAM] 过滤后的已完成附件数量: ${completedAttachments.length}`);
        
        if (completedAttachments.length > 0) {
          console.log(`[STREAM] 发现 ${completedAttachments.length} 个已完成的附件，构造多模态消息`);
          console.log(`[STREAM] 附件详情:`, completedAttachments.map(a => ({
            name: a.name,
            contentType: a.contentType,
            fileId: a.fileId,
            isImage: a.contentType?.startsWith("image/")
          })));
          
          // 构造包含附件的多模态消息
          const enhancedMessages = messages.map((msg, index) => {
            if (index === messages.length - 1 && msg.type === "human") {
              console.log(`[STREAM] 处理最后一个用户消息:`, msg);
              
              // 构造附件内容部分
              const attachmentParts = completedAttachments.map(attachment => {
                if (attachment.contentType?.startsWith("image/")) {
                  // 图片附件：后端工具触发需要对象结构（包含 image_id）
                  const abs = normalizeImageSrc(attachment.url);
                  return {
                    type: "image" as const,
                    image: {
                      image_id: attachment.fileId,
                      url: abs || attachment.url,
                      thumb_url: abs || attachment.url,
                      mime_type: attachment.contentType,
                      size: attachment.size || 0,
                    }
                  };
                } else {
                  // 文档附件：构造文本描述
                  return {
                    type: "text" as const,
                    text: `文件信息: ${attachment.name} (${attachment.contentType})`
                  };
                }
              });
              
              const enhancedMessage = {
                ...msg,
                content: [
                  ...attachmentParts,
                  ...(Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content }])
                ]
              };
              
              console.log(`[STREAM] 增强后的消息:`, enhancedMessage);
              console.log(`[STREAM] 消息内容部分数量:`, enhancedMessage.content.length);
              
              return enhancedMessage;
            }
            return msg;
          });
          
          console.log(`[STREAM] 发送多模态消息，包含 ${completedAttachments.length} 个附件`);
          
          // 如果是首页场景（没有 conversationId），先创建新会话
          let finalConversationId = conversationId;
          let finalThreadId = currentThreadId;

          if (!conversationId) {
            console.log(`[STREAM] 首页场景（附件）：创建新会话`);
            try {
              const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: '新聊天' }),
              });
              if (response.ok) {
                const newConv = await response.json();
                finalConversationId = newConv.id;
                finalThreadId = newConv.threadId || currentThreadId;
                console.log(`[STREAM] 创建新会话成功（附件）:`, { conversationId: finalConversationId, threadId: finalThreadId });
                
                // 同页：仅替换 URL，继续在本页流式
                try { window.history.replaceState({}, '', `/chat/${finalConversationId}`); } catch {}
                // 方案C：上下文层已切换，无需补派发
              } else {
                console.error(`[STREAM] 创建会话失败（附件）:`, response.status);
                throw new Error(`创建会话失败: ${response.status}`);
              }
            } catch (error) {
              console.error(`[STREAM] 创建会话异常（附件）:`, error);
              throw error;
            }
          }
          
          const streamResponse = await sendMessage({
            conversationId: finalConversationId || "",
            threadId: finalThreadId!,
            messages: enhancedMessages,
          });
          
          // 延迟清除附件，在流式处理完成后再清除
          setTimeout(() => {
            setAttachments((prev) => {
              const newState = prev.filter(a => !completedAttachments.some(ca => ca.id === a.id));
              updateAttachmentsRef(newState);
              console.log(`[STREAM] 延迟清除附件，剩余数量: ${newState.length}`);
              return newState;
            });
          }, 1000); // 延迟1秒清除
          
          return convertToLangGraphFormat(streamResponse);
        } else {
          // 没有附件，或存在图片则走图片问答
          console.log(`[STREAM] 发送普通消息`);
          
          // 如果是首页场景（没有 conversationId），先创建新会话
          let finalConversationId = conversationId;
          let finalThreadId = currentThreadId;

          if (!conversationId) {
            console.log(`[STREAM] 首页场景：创建新会话`);
            try {
              const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: '新聊天' }),
              });
              if (response.ok) {
                const newConv = await response.json();
                finalConversationId = newConv.id;
                finalThreadId = newConv.threadId || currentThreadId;
                console.log(`[STREAM] 创建新会话成功:`, { conversationId: finalConversationId, threadId: finalThreadId });
                
                // 同页：仅替换 URL，继续在本页流式
                try { window.history.replaceState({}, '', `/chat/${finalConversationId}`); } catch {}
                // 方案C：上下文层已切换，无需补派发
              } else {
                console.error(`[STREAM] 创建会话失败:`, response.status);
                throw new Error(`创建会话失败: ${response.status}`);
              }
            } catch (error) {
              console.error(`[STREAM] 创建会话异常:`, error);
              throw error;
            }
          }
          
          // 直接发送消息，让 AttachmentAdapter 处理所有文件类型
          console.log(`[STREAM] 发送消息到后端，消息数量: ${messages.length}`);

          const streamResponse = await sendMessage({
            conversationId: finalConversationId || "",
            threadId: finalThreadId!,
            messages,
          });
          
          return convertToLangGraphFormat(streamResponse);
        }
      } catch (error) {
        console.error(`[STREAM] 处理错误:`, error);
        throw error;
      } finally {
        isStreamingRef.current = false;
        console.log(`[STREAM] 处理完成`);
        try { console.log(`[STREAM] runtime post-export len`, (runtime as any)?.export?.()?.messages?.length); } catch {}
      }
    },
    adapters: { attachments: attachmentAdapter },
  });

  // 首页：在 runtime 就绪后做一次 reset，清空旧消息，随后标记 hasHomeReset=true
  useEffect(() => {
    (async () => {
      try {
        if (conversationId) return; // 仅首页
        if (!runtime) return;
        if (hasHomeReset) return;
        try {
          if (typeof (runtime as any)?.reset === 'function') {
            console.log('[RT] reset:home runtime before');
            await (runtime as any).reset();
            console.log('[RT] reset:home runtime after', (runtime as any)?.export?.()?.messages?.length);
          }
        } catch (e) {
          console.warn('[RT] reset:home runtime failed', e);
        }
        setHasHomeReset(true);
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, runtime, hasHomeReset]);

  // 调试：挂载只读句柄到 window，跟踪 runtime 生命周期
  useEffect(() => {
    try {
      (window as any).__AUI_RT__ = { runtime, runtimeId: runtimeIdRef.current, conversationId };
      console.log(`[RT] mount`, { runtimeId: runtimeIdRef.current, conversationId });
      return () => {
        try {
          console.log(`[RT] unmount`, { runtimeId: runtimeIdRef.current, conversationId });
          if ((window as any).__AUI_RT__?.runtime === runtime) {
            delete (window as any).__AUI_RT__;
          }
        } catch {}
      };
    } catch {}
  }, [runtime, conversationId]);

  // 只在 threadId 和 runtime 都确定后才渲染
  if (!threadId || !runtime) {
    console.log(`[RT] Waiting for threadId or runtime...`, { conversationId, hasThreadId: !!threadId, hasRuntime: !!runtime });
    return <div>Loading...</div>;
  }

  return (
    <ChatUIContext.Provider value={{ isChatting: uiIsChatting, setIsChatting: setUiIsChatting, hasHomeReset, setHasHomeReset }}>
      <AssistantRuntimeProvider runtime={runtime}>
        <MessageAppender />
        {children}
      </AssistantRuntimeProvider>
    </ChatUIContext.Provider>
  );
}

// 在 Provider 内部使用 useThreadRuntime 来真正向线程追加文本消息
function MessageAppender() {
  const thread = useThreadRuntime();
  useEffect(() => {
    console.log('[MessageAppender] mount - 简化版本，只处理文本消息');
    const onAppendText = (e: Event) => {
      console.log('[MessageAppender] 收到 appendTextMessage 事件');
      const ce = e as CustomEvent<{ text: string }>;
      const text = ce?.detail?.text || "";
      if (!text) return;
      try {
        const before = (thread as any)?.export?.()?.messages?.length;
        console.log('[MessageAppender] 追加前线程消息数:', before);
        (thread as any)?.append?.({ id: `msg_${Date.now()}`, type: 'human', content: [{ type: 'text', text }] });
        const after = (thread as any)?.export?.()?.messages?.length;
        console.log('[MessageAppender] 已追加文本消息:', text, '；线程消息数:', after);
      } catch {}
    };
    window.addEventListener('appendTextMessage', onAppendText as EventListener);
    return () => {
      window.removeEventListener('appendTextMessage', onAppendText as EventListener);
      console.log('[MessageAppender] unmount');
    };
  }, [thread]);
  return null;
}

// 调试：在 Provider 层观察 runtime 的生命周期与 import/export 调用（不改变行为）
// 将在 runtime 变更时打点，并将只读引用挂到 window 便于控制台比对
// 注意：这些日志可随时移除，不影响功能

// 移除 MessageAppender 组件，返回到原始的 UI 更新机制

// 组件外不做实例级日志

