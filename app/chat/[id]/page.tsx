import { prisma } from "@/lib/db";
import ClientPage from "./ClientPage";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let hasHistory = false;
  try {
    const count = await prisma.message.count({ where: { conversationId: id } });
    hasHistory = count > 0;
  } catch {}
  try { console.log(`[SRV] chat initialHasHistory`, { id, hasHistory }); } catch {}
  return <ClientPage params={Promise.resolve({ id })} initialHasHistory={hasHistory} />;
}


