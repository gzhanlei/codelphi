# 无独立专家条件下的语义继承验证报告（2026-11-24）

状态：**验证完成；Kotlin 10 项通过，Python 因测试数据库配置缺失未执行。** 本报告不把任何模型或脚本冒充独立领域专家。

## 1. 替代验证框架

没有独立领域专家时，采用四层互补证据：

1. **机器答案键**：直接读取 Git 内容，验证实现事实、路径和 tree 坐标。
2. **匿名模型复核**：只给候选场景与附近代码，屏蔽裁决理由和预期答案，检查另一轮模型是否读出相同事实。
3. **故障注入**：验证过期核实、身份碰撞、回滚、平台复用等危险情况不会静默继承。
4. **可执行测试**：运行相关项目的定向测试以及 CoDelphi 全量检查。

这四层都不能单独证明产品意图或运行时正确性，结论按证据边界分别陈述。

## 2. 机器答案键

产物：`../../artifacts/semantic-inheritance/machine-oracle.json`。

检查覆盖：

- SB-003：Mobile 的 `LinkAnnotation.Url`、`UrlLauncher` 和非 HTTP scheme 测试均存在。
- CH-001：双配置校验、partner 豁免、缓冲期和前端 reset 均存在。
- CH-002：Turnstile 包与请求字段已移除，partner 注册分支保留。
- TF-002：唯一变更文件是 `ios/Tests/README.md`。
- Turnstile 加入前与回滚后的 Git tree 完全相同。

首次 tree 检查曾错误比较“加入 Turnstile 后”与“回滚后”，未通过；随后改为“加入前”与“回滚后”并保留误检记录。修正后全部检查通过，未通过修改事实获得全绿。

## 3. 匿名模型复核

产物：`../../artifacts/semantic-inheritance/blind-review.json`。

- 复核调用：12 次（9 次初审 + 3 次仅针对证据不足的补充片段）。
- 模型：ds-flash；没有第二模型可用，`multiModel=false`，不宣称多模型一致性。
- 屏蔽字段：裁决理由、裁决人、变化来源、预期支持结果。
- 最终结果：**7 support、1 contradict、1 insufficient**。
- TF-002 被判定为 contradict：测试 README 与编译命令不构成产品行为变化。
- CH-001 的 Web 与配置场景在补充完整代码后获得 support。
- SB-003 HP-2 仍为 insufficient：模型认为多 URL 全部被标注及换行保留的证据不足，**保持未核实，不强行改判**。

匿名复核只说明模型对代码片段的另一种读取，不是业务验收或独立专家结论。

## 4. 故障注入

产物：`../../artifacts/semantic-inheritance/fault-injection.json`。

7 项检查全部通过：

- 未变行为保持已核实；
- 相关行为变化转为待重新核实；
- 新行为与身份碰撞保持未核实并保留历史；
- tree 回滚不自动恢复当前已核实；
- CH-002 碰撞场景被隔离，新 partner 行为使用新 EC-4；
- Mobile 新场景全部保持未核实。

这些是合成迁移规则与真实碰撞/平台夹具，不是生产核实记录恢复。

## 5. 可执行测试

| 项目 | 命令与范围 | 结果 |
| --- | --- | --- |
| SalesBuddy Web | `npx vitest run src/components/__tests__/AssistantChatDrawer.spec.ts` | **9 项通过** |
| SalesBuddy Kotlin | `:shared:testDebugUnitTest --tests AssistantChatLinksTest --rerun-tasks` | **10 项实际执行通过** |
| SalesBuddy Python | `pytest test_assistant_intent.py test_assistant_query.py test_assistant_service_safety.py` | **未执行：conftest 要求 TEST_MYSQL_ADMIN_URL，未绕过** |
| Tingfeng | `swiftc` target-watch 定向套件 | **10 项通过** |
| Chandler Go | `go test ./internal/config ./internal/handlers ./internal/turnstile`（固定历史提交） | **全部通过** |
| Chandler Web | `vitest Turnstile.test.tsx + register/page.test.tsx`（固定历史提交） | **14 项通过** |
| CoDelphi 本实验 | 3 个语义继承测试文件 | **18 项通过** |
| CoDelphi 全量 | `npm test`、`npm run typecheck`、`npm run build` | **全部通过** |

Kotlin 首次运行在 task graph 阶段超时，未进入测试。离线复查定位为 `androidx.lifecycle:lifecycle-viewmodel-ktx:2.9.0` 缓存缺失，随后改为单进程并允许正常依赖解析。依赖构建成功后，测试任务一度显示 `UP-TO-DATE`，未将其计为实际执行；最终以 `--rerun-tasks` 强制执行并完成，测试报告为 `tests=10, skipped=0, failures=0, errors=0`，归档于 `../../artifacts/semantic-inheritance/AssistantChatLinksTest.xml`。

## 6. 当前能与不能得出的结论

可以得出：

- 四份 AI 预标裁决的主要实现事实有直接 Git 证据支持。
- 新行为漏报和 reference 碰撞可以被确定性门禁发现，并进入待复核而非静默继承。
- 本次相关定向测试和 CoDelphi 全量检查支持实验代码的当前实现。

不能得出：

- 产品意图或业务语义已经由领域专家验收；
- 所有新场景均已充分证实，尤其 SB-003 HP-2 仍是 insufficient；
- 真实设备、浏览器、外部服务、生产配置或生产核实记录已验证；
- 语义继承已在未参与调参的新项目或新窗口上普遍成立。

## 7. 后续建议

1. 将机器答案键与故障注入纳入 CI，优先于增加模型评审次数。
2. 对 insufficient 场景保持未核实，不通过换模型或改提示词追求支持。
3. 使用未参与调参的新窗口验证，并恢复真实历史人工修正和核实状态。
4. Python 测试需要合规的测试数据库配置；Kotlin 若仍无法完成，只标记验证缺口，不降低门禁。
