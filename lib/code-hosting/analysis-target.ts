import { getCodeHostingAdapter } from "./registry";
import type { CodeHostingProvider } from "./types";

interface AnalysisTargetRun {
  productId: number;
  productSlug: string;
  productName: string;
  connectionId: number | null;
  organizationId: number;
  provider: CodeHostingProvider;
}

export function resolveAnalysisTarget(run: AnalysisTargetRun) {
  const adapter = getCodeHostingAdapter(run.provider);
  return {
    adapter,
    access: { connectionId: run.connectionId, organizationId: run.organizationId },
    product: {
      id: run.productId,
      slug: run.productSlug,
      name: run.productName,
    },
  };
}
