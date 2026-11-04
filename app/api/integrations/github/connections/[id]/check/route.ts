import { createConnectionCheckHandler } from "@/lib/connection-check-route";
import { checkGitHubConnection } from "@/lib/github-connections";

export const runtime = "nodejs";
export const POST = createConnectionCheckHandler(checkGitHubConnection);
