<!-- CODEGRAPH_START -->
## CodeGraph

本项目配置了 CodeGraph MCP（`codegraph_*` 工具）。详细工具选择表见 MCP 系统指令。

### 项目级规则

- **直接回答，不要委派探索。** "X 怎么工作"类问题用 2-3 次 codegraph 调用搞定，不要 spawn 子 agent 或跑 grep+read 循环。
- **信任 codegraph 结果。** 基于 AST 解析，不要用 grep 再验证。
- **不要 grep 先查。** 查符号用 `codegraph_search`，要上下文用 `codegraph_context`，不要先 grep。
- **不要循环 `codegraph_node`。** 多符号用一个 `codegraph_explore` 调用。
- **Index lag**: 文件写入后 ~500ms 才更新，同轮编辑后不要立即重查。

### 如果 `.codegraph/` 不存在

MCP 返回 "not initialized"，提示用户：*"这个项目还没初始化 CodeGraph，要我跑 `codegraph init -i` 吗？"*
<!-- CODEGRAPH_END -->