# 重构进度追踪（临时）

> 目标：按模块拆分并逐步收敛职责边界；每个主题独立 commit。

## 任务清单

- [ ] 1. 启动与运行时依赖图收敛（bootstrap/runtime）
- [ ] 2. 入站消息链路拆分（messageEventHandler）
- [ ] 3. 生成执行器拆分（generationExecutor）
- [ ] 4. BrowserService 职责拆分
- [ ] 5. SessionManager epoch/revision guard 收敛
- [ ] 6. Web tools 模块拆分
- [ ] 7. WebUI/后端流协议类型收敛
- [ ] 8. Sessions 页轮询与 SSE 策略收敛
- [ ] 9. prompt 语言约定统一（中文）
- [ ] 10. Internal API 依赖接口瘦身

## 提交记录

- [ ] commit A：新增追踪文件
- [ ] commit B：消息入站链路拆分
- [ ] commit C：生成执行器拆分
- [ ] commit D：Session guard 收敛
- [ ] commit E：Web tools 拆分
- [ ] commit F：协议类型收敛
- [ ] commit G：SSE/轮询策略调整
- [ ] commit H：prompt 语言统一
- [ ] commit I：bootstrap/runtime 与 internalApi 依赖收敛

