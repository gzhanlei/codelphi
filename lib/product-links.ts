/** 产品页 canonical 地址基路径：/products/{orgSlug}/{slug}。
 *  站内页面链接一律经此构造（slug 单段地址已降级为重定向入口）；
 *  API fetch 路径仍为 /api/products/{slug}，与本 helper 无关。 */
export function productBasePath(orgSlug: string, slug: string): string {
  return `/products/${encodeURIComponent(orgSlug)}/${encodeURIComponent(slug)}`;
}
