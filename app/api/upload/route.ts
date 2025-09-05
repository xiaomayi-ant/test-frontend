import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const threadId = formData.get("threadId") as string;

    console.log(`[Upload API] 接收到文件上传请求`);
    console.log(`[Upload API] 文件信息:`, {
      name: file?.name,
      type: file?.type,
      size: file?.size,
      threadId
    });

    if (!file) {
      console.log(`[Upload API] 错误: 没有提供文件`);
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // threadId 改为可选：若传则透传给后端/用于后续关联；未传不阻断上传
    if (!threadId) {
      console.log(`[Upload API] 提示: 未提供 threadId（允许，无阻断）`);
    }

    // 验证文件类型
    const allowedTypes = ["text/plain", "application/pdf", "image/jpeg", "image/png"];
    console.log(`[Upload API] 文件类型: ${file.type}, 允许的类型: ${allowedTypes.join(", ")}`);
    
    if (!allowedTypes.includes(file.type)) {
      console.log(`[Upload API] 错误: 不支持的文件类型 ${file.type}`);
      return NextResponse.json({ error: `Unsupported file type: ${file.type}` }, { status: 400 });
    }

    // 验证文件大小 (10MB)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      console.log(`[Upload API] 错误: 文件大小超过限制 ${file.size} > ${maxSize}`);
      return NextResponse.json({ error: "File size exceeds 10MB limit" }, { status: 400 });
    }

    // 如果是 PDF，则将 FormData 原样转发到后端文档处理接口
    if (file.type === "application/pdf") {
      try {
        const backendBaseUrl = process.env["NEXT_PUBLIC_BACKEND_BASE_URL"] || "http://localhost:8080";
        const category = (formData.get("category") as string) || null;
        const mode = request.nextUrl.searchParams.get('mode'); // 获取 mode 参数
        
        // 构建查询参数
        const params = new URLSearchParams();
        if (category) params.set('category', category);
        if (mode) params.set('mode', mode);
        
        const targetUrl = `${backendBaseUrl}/api/documents/upload${params.toString() ? '?' + params.toString() : ''}`;

        console.log(`[Upload API] PDF 文件，代理转发到后端: ${targetUrl}`);

        const backendRes = await fetch(targetUrl, {
          method: "POST",
          body: formData,
        });

        // 直接透传后端状态码与结果
        const text = await backendRes.text();
        try {
          const json = JSON.parse(text);
          return NextResponse.json(json, { status: backendRes.status });
        } catch {
          // 后端返回非JSON时，包装为对象
          return NextResponse.json({ raw: text }, { status: backendRes.status });
        }
      } catch (err: any) {
        console.error(`[Upload API] 代理后端处理失败:`, err);
        return NextResponse.json({ error: "Proxy to backend failed", details: err?.message }, { status: 502 });
      }
    }

    // 生成唯一文件ID
    const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    // 模拟文件上传到存储服务
    // 在实际应用中，这里应该上传到云存储服务（如AWS S3、Google Cloud Storage等）
    const url = `https://example.com/uploads/${fileId}/${file.name}`;

    console.log(`[Upload API] 文件上传成功:`, { fileId, url, name: file.name });

    // 返回文件信息（非PDF：直接标记为 ready，避免前端轮询后端状态）
    return NextResponse.json({
      fileId,
      url,
      name: file.name,
      contentType: file.type,
      size: file.size,
      status: "ready",
    });

  } catch (error: any) {
    console.error("[Upload API] 上传错误:", error);
    return NextResponse.json(
      { error: "Upload failed", details: error.message },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
