interface OrderInput {
  sku: string;
  quantity: number;
}

declare function requireUser(request: Request): Promise<{ id: string; role: string } | null>;
declare function listOrders(userId: string): Promise<OrderInput[]>;
declare function createOrder(userId: string, input: OrderInput): Promise<OrderInput>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function parseOrderInput(body: unknown): OrderInput | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Partial<OrderInput>;
  if (typeof candidate.sku !== "string" || typeof candidate.quantity !== "number") return null;
  if (!Number.isInteger(candidate.quantity) || candidate.quantity <= 0) return null;
  return { sku: candidate.sku, quantity: candidate.quantity };
}

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }
  if (user.role !== "admin" && user.role !== "member") {
    return json({ error: "forbidden" }, 403);
  }
  const orders = await listOrders(user.id);
  return json({ orders });
}

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) {
    return json({ error: "unauthorized" }, 401);
  }
  const input = parseOrderInput(await request.json());
  if (!input) {
    return json({ error: "invalid_order" }, 400);
  }
  try {
    const order = await createOrder(user.id, input);
    return json({ order }, 201);
  } catch {
    return json({ error: "create_failed" }, 500);
  }
}
