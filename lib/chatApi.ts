import { ThreadState, Client } from "@langchain/langgraph-sdk";
import { LangChainMessage } from "@assistant-ui/react-langgraph";

const createClient = () => {
  const apiUrl =
    process.env["NEXT_PUBLIC_LANGGRAPH_API_URL"] ||
    new URL("/api", window.location.href).href;
  return new Client({
    apiUrl,
  });
};

export const createAssistant = async (graphId: string) => {
  const client = createClient();
  return client.assistants.create({ graphId });
};

export const createThread = async () => {
  const client = createClient();
  return client.threads.create();
};

export const getThreadState = async (
  threadId: string
): Promise<ThreadState<Record<string, any>>> => {
  const client = createClient();
  return client.threads.getState(threadId);
};

export const updateState = async (
  threadId: string,
  fields: {
    newState: Record<string, any>;
    asNode?: string;
  }
) => {
  const client = createClient();
  return client.threads.updateState(threadId, {
    values: fields.newState,
    asNode: fields.asNode!,
  });
};

export const sendMessage = async (params: {
  conversationId: string;
  threadId: string;
  messages: LangChainMessage[];
}) => {
  console.log(`[chatApi] 发送消息到: /api/chat/stream`);
  console.log(`[chatApi] 会话: ${params.conversationId}, 线程: ${params.threadId}`);
  console.log(`[chatApi] 消息内容:`, params.messages);
  
  const response = await fetch(`/api/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversationId: params.conversationId,
      threadId: params.threadId,
      messages: params.messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  // 创建一个异步生成器来处理SSE流
  const stream = (async function* () {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 逐块解析（以空行分隔的 SSE 事件块）
        let separatorIndex: number;
        // 兼容 \n\n 和 \r\n\r\n 两种分隔
        // 优先查找 \n\n，如未找到再查找 \r\n\r\n
        // 循环消费完整块
        while ((separatorIndex = buffer.indexOf("\n\n")) !== -1 || (separatorIndex = buffer.indexOf("\r\n\r\n")) !== -1) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === "\r" ? 4 : 2));

          // 解析单个块
          const lines = block.split(/\r?\n/);
          let event: string | null = null;
          const dataLines: string[] = [];

          for (const line of lines) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }

          if (!event) {
            continue; // 没有事件名则跳过
          }

          const dataStr = dataLines.join("\n");
          if (!dataStr) {
            yield { event, data: [] };
            continue;
          }

          try {
            const parsedData = JSON.parse(dataStr);
            yield { event, data: parsedData };
          } catch (e) {
            console.warn(`[chatApi] 解析SSE数据失败:`, dataStr, e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return stream;
};

export const visionStream = async (params: {
  file: File;
  question: string;
}) => {
  const formData = new FormData();
  formData.append("image", params.file);
  formData.append("question", params.question || "请描述这张图片");

  const response = await fetch(`/api/vision-qa`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const stream = (async function* () {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separatorIndex: number;
        while (
          (separatorIndex = buffer.indexOf("\n\n")) !== -1 ||
          (separatorIndex = buffer.indexOf("\r\n\r\n")) !== -1
        ) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + (buffer[separatorIndex] === "\r" ? 4 : 2));
          const lines = block.split(/\r?\n/);
          let event: string | null = null;
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (!event) event = "message"; // default for provider lines without explicit event
          const dataStr = dataLines.join("\n");
          if (!dataStr) {
            yield { event, data: [] };
            continue;
          }
          if (dataStr === "[DONE]") {
            yield { event: "done", data: null } as any;
            break;
          }
          try {
            const parsedData = JSON.parse(dataStr);
            yield { event, data: parsedData };
          } catch (e) {
            console.warn(`[chatApi] 解析SSE数据失败:`, dataStr, e);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return stream;
};

// 异步上传文件，立即返回文件指针
export const uploadAsync = async (file: File, threadId?: string): Promise<{
  fileId: string;
  url: string;
  thumbUrl?: string;
  name: string;
  mime: string;
  size: number;
  status: string;
}> => {
  console.log(`[chatApi] 异步上传文件: ${file.name}`);
  
  // 图片走 /api/images，其他仍走 /api/upload
  const formData = new FormData();
  formData.append('file', file);
  if (threadId) formData.append('threadId', threadId);

  if (file.type.startsWith('image/')) {
    const imgRes = await fetch(`/api/images`, { method: 'POST', body: formData });
    if (!imgRes.ok) {
      throw new Error(`Image upload failed: ${imgRes.status}`);
    }
    const imgJson = await imgRes.json();
    console.log(`[chatApi] 图片上传结果:`, imgJson);
    return {
      fileId: imgJson.image_id,
      url: imgJson.url,
      thumbUrl: imgJson.thumb_url,
      name: file.name,
      mime: file.type,
      size: file.size,
      status: 'ready',
    };
  }

  const response = await fetch(`/api/upload?mode=async`, { method: 'POST', body: formData });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  const result = await response.json();
  console.log(`[chatApi] 异步上传结果:`, result);
  return {
    fileId: result.fileId,
    url: result.url,
    name: result.name || file.name,
    mime: result.mime || file.type,
    size: result.size || file.size,
    status: result.status || 'processing',
  };
};

// 轮询文件处理状态
export const pollFileStatus = async (fileId: string): Promise<{
  status: 'processing' | 'ready' | 'failed';
  filename?: string;
  result?: any;
  error?: string;
}> => {
  console.log(`[chatApi] 查询文件状态: ${fileId}`);
  
  const response = await fetch(`/api/documents/status?fileId=${fileId}`);
  
  if (!response.ok) {
    throw new Error(`Status query failed: ${response.status}`);
  }
  
  const result = await response.json();
  console.log(`[chatApi] 文件状态:`, result);
  
  return {
    status: result.status,
    filename: result.filename,
    result: result.result,
    error: result.error
  };
};