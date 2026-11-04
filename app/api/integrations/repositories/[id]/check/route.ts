import { createConnectionCheckHandler } from "@/lib/connection-check-route";
import { checkRepositoryConnection } from "@/lib/repository-connections";

export const runtime = "nodejs";
export const POST = createConnectionCheckHandler(checkRepositoryConnection);
