// Package billing 是授权与计费的唯一实现：
// Org / OrgUnit / Member / License / QuotaPool / UsageRecord / AuditLog，
// 以及 Authorize / Settle 闸门（设计 §3、§4）。
//
// 边界（设计 §2，浇死在代码里）：
//   - 本包不得 import 任何 vendor/adapter SDK；
//   - execution 只能调本包的 Authorize/Settle，不得直接 UPDATE 配额表；
//   - 计数器（QuotaPool）服务闸门，台账（UsageRecord）服务报表，两者不交叉；
//   - 扣费粒度 = step：每个 step 各自 Authorize/Settle，不整单预扣。
package billing
