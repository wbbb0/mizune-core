# DeepSeek provider 与原生搜索

`type: deepseek` 使用 Anthropic Messages 协议，默认地址为
`https://api.deepseek.com/anthropic`，请求路径为 `/v1/messages`。
认证使用 `x-api-key`。它与 Anthropic provider 共享消息转换、流式解析和内容块回传；
DeepSeek 的默认地址、思考参数与搜索声明按其接口约定处理。

配置了自定义 `baseUrl` 时，该地址必须是 Anthropic 兼容接口的前缀，不含
`/v1/messages`。旧的 Chat Completions 地址和参数不会自动迁移。
模型名使用目录中的 `upstreamModel`，不在 provider 内做模型名映射。

## 启用搜索

WebUI 中选择 DeepSeek 供应商，在模型上开启“允许联网搜索”即可。
搜索工具类型、名称由协议实现生成，不需要填写 JSON。
供应商下的“原生搜索设置”可以调整次数上限，默认 3 次。

对应 `config/llm.catalog.yml`：

```yaml
deepseek:
  type: deepseek
  baseUrl: https://api.deepseek.com/anthropic
  apiKey: replace-me
  proxy: false
  search:
    maxUses: 3
  models:
    flash:
      upstreamModel: deepseek-flash
      modelType: chat
      supportsThinking: true
      thinkingControllable: true
      preserveThinking: true
      supportsSearch: true
      supportsTools: true
```

搜索由模型自动选择，普通函数工具可以同时存在。不要用 `enable_search` 布尔参数，
也不要强制所有请求只调用搜索工具。达到搜索次数限制时，服务端可能返回
`max_uses_exceeded`，模型仍可能基于已成功返回的结果完成回答。

## 结果、续轮与显示

- `server_tool_use` 和 `web_search_tool_result` 是服务端执行结果，不进入本地函数工具队列。
- 原始内容块保存在 `assistantMetadata.anthropicContentBlocks`，随后通过 transcript
  的 `providerMetadata` 回传；搜索结果中的 `encrypted_content` 必须保留。
- 思考、普通函数调用和搜索结果维持原有内容块顺序，普通工具结果转换为用户消息里的 `tool_result`。
- Sessions 页在对应模型回复或工具调用条目中提供“联网搜索来源与状态”折叠区；
  显示来源标题、HTTP(S) 链接和搜索错误，不显示加密回传内容。搜索过程不新增本地工具执行条目。
- 原始接口用量保存在 `anthropicUsage`，包含接口返回的搜索请求计数；
  通用输入用量合计未缓存输入、缓存读取与缓存写入，避免少计命中缓存的输入；不根据搜索结果条数推算费用。
- DeepSeek 流必须收到 `message_stop` 和明确结束原因；截断或 `pause_turn` 等未完成响应会报错，
  不把不完整结果视为成功。

搜索会产生额外模型 token 用量。支持性与计费以实际模型、端点返回和官方说明为准。

## 真实 smoke

默认 `npm run test` 不访问真实模型。显式运行：

```bash
CONFIG_DIR=/absolute/path/to/config CONFIG_INSTANCE=dev \
  SMOKE_PROVIDER=deepseek SMOKE_MODEL=deepseek-flash \
  npm run smoke:llm:deepseek-search
```

脚本只读取现有配置，在内存中启用搜索、限制输出长度和超时；使用临时数据目录，
关闭请求 dump，不启动 HTTP 服务，不写实例配置或会话数据。
它验证真实流式搜索来源、最终回答、搜索结果回传，以及开启思考后的普通工具续轮。
输出只包含结果摘要、来源和用量，不输出 API key 或加密内容块。

官方参考：
- [Anthropic 接口兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)
- [原生搜索与费用说明](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/#using-web-search-in-claude-code)
