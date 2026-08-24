// Package execution 负责 job 状态机与平台适配：
// lesson 权威状态机（设计 → 大纲 → awaiting_confirm → PPT+讲稿）、
// adapters/*（PPTCreator partner、design/outline LLM adapter、后续数字人/AI3D）、
// 合成器（成品 pptx 逐页出图 + 人像旁挂）。
//
// 边界（设计 §2、§7）：
//   - lesson 拓扑硬编码，不做 DAG 引擎；
//   - 并发公平按 (org, platform)；
//   - adapter 故障只 fail 对应 job，billing 不可用才整体 fail-closed；
//   - 材料与产物一律经 internal/storage 的本侧对象存储交换，不转手平台临时链。
package execution
