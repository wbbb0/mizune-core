# 用户上下文混合检索 Orama POC

这是 `poc/user-context-hybrid-retrieval` 的 Node.js / Orama 版本，用来验证是否可以用一个更贴近本项目技术栈、依赖更轻的本地检索库替代 Python POC 里的 Qdrant local mode。

## 目标

- 使用 Orama 建立本地内存索引。
- 使用项目侧 embedding provider 生成向量，不绑定 Orama embedding 插件。
- 在线按“当前用户 + 当前消息”执行 hybrid search。
- 保留项目自己的重排逻辑：
  - 新鲜度加权
  - `summary` 加权
  - 近重复抑制
  - debug reasoning 输出
- 不引入 LangChain / LlamaIndex 这类完整 RAG 框架。

## 为什么这样接 Orama

Orama 在这里只承担“候选召回层”职责：

- full-text / BM25
- vector search
- hybrid merge
- metadata filter

以下逻辑仍留在项目内：

- 当前用户权限边界
- chunk / summary / fact 分层语义
- recency / sourceType / token budget 策略
- prompt 注入格式
- 后续后台摘要与事实提炼任务

这样可以验证 Orama 是否足够覆盖第一阶段需求，同时保持未来替换为 LanceDB、Qdrant 或 SQLite 方案的接口边界。

## 目录

- `src/retriever.mjs`
  - Orama hybrid retriever 与项目侧重排逻辑
- `src/tokenizer.mjs`
  - 面向中英文混合聊天文本的自定义 tokenizer
- `src/openai-compat.mjs`
  - 最小 OpenAI 兼容 embedding / chat client
- `src/demo-data.mjs`
  - 与 Python POC 对齐的演示数据
- `tests/`
  - 检索行为测试
- `demo.mjs`
  - 最小演示入口

## 安装

```bash
cd poc/user-context-hybrid-retrieval-orama
npm install
```

## 测试

```bash
cd poc/user-context-hybrid-retrieval-orama
npm test
```

## 只运行检索演示

```bash
cd poc/user-context-hybrid-retrieval-orama
POC_OPENAI_API_KEY='<your-key>' \
npm run demo -- --demo assistant_preferences --skip-chat --plain
```

## 运行完整演示

```bash
cd poc/user-context-hybrid-retrieval-orama
POC_OPENAI_API_KEY='<your-key>' \
npm run demo -- --demo nas_cleanup --plain
```

常用参数：

- `--skip-chat`
  - 只看检索结果，不调聊天模型
- `--query`
  - 覆盖当前用户消息
- `--demo`
  - 选择内置场景：`assistant_preferences`、`nas_cleanup`、`adult_rp`
- `--base-url`
  - 自定义聊天模型 OpenAI 兼容地址
- `--embedding-base-url`
  - 自定义 embedding 模型地址，默认 `http://localhost:1234/v1`
- `--chat-model`
  - 自定义聊天模型
- `--embedding-model`
  - 自定义 embedding 模型
- `--load-chat-model`
  - 若聊天模型当前未加载，先通过 LM Studio 原生接口尝试加载
- `--candidate-limit`
  - 控制 `Retrieval Reasoning` 最多打印多少条候选
- `--hide-retrieval-reasoning`
  - 隐藏检索侧 reasoning 输出
- `--hide-model-reasoning`
  - 隐藏模型侧 reasoning 输出
- `--plain`
  - 关闭 ANSI 颜色

## 当前实现说明

- Orama 索引是内存态，当前 POC 不做持久化。
- Orama 使用自定义 tokenizer 处理中文 bigram 与英文 / 数字 token。
- 检索分数由两层组成：
  - Orama hybrid score：BM25/full-text 与向量召回融合
  - 项目侧重排：新鲜度、摘要加权、近重复抑制
- 测试使用静态 embedding，不依赖外部模型服务。

## 与 Python/Qdrant POC 的差异

- Python POC 用 Qdrant local mode 存储向量，词面重合度由项目代码手写。
- Orama POC 用 Orama 同时做 BM25 和向量 hybrid 候选召回。
- Orama 版没有引入完整 RAG pipeline，只验证检索库是否可替代底层候选召回层。
