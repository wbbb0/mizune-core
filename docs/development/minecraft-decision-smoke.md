# Minecraft 决策真实模型 smoke

Minecraft Actor 的默认回归不调用真实模型。需要验证十秒级决策、无思考端点或 Python 程序生成时，显式运行：

```bash
npm run smoke:llm:minecraft -- --instance web --model-ref ds_deepseek_v4_flash --case behavior --runs 3 --timeout-ms 10000
npm run smoke:llm:minecraft -- --instance web --model-ref ds_deepseek_v4_pro --case program --runs 1 --timeout-ms 30000
```

`behavior` 会验证模型读取必要状态、提交一个安全相关高层行为或任务，并调用结束工具。战斗、撤离或移动到安全位置都可以是合理答案，不固定模型的上层策略。

`program` 会要求模型完成读取当前程序、提交完整 Python 源码、validate 和 activate；随后使用子模块的 Python AST 预检器再次验证实际源码。静态预检只验证允许的语言结构和 capability，不表示脚本已经具备 OS 级安全隔离。

2026-08-13 使用生产 DeepSeek provider 的最新实测结果（控制幂等键改由系统生成后复测）：

- `deepseek-v4-flash` 关闭思考，三次 behavior 分别约为 6.40、7.85、8.90 秒，均在 10 秒截止内完成；reasoning token 均为 0。另一次 INFO 级诊断复测约 6.76 秒，模型直接使用了无幂等键的简化控制 schema。
- `deepseek-v4-pro` 关闭思考，完整 program 读取、生成、校验和激活约为 10.33 秒，reasoning token 为 0。

因此普通事件决策可以继续使用十秒级快路径，但 8.90 秒已接近截止，安全响应仍必须由反射层和已提交的状态机负责。模型只在关键节点选择高层行为；完整程序发布属于低频路径，应使用更宽截止时间，不能阻塞反射或已运行的确定性状态机。
