# Owner 身份与会话标识重构设计

## 背景

当前系统里混杂了三种语义：

- `owner` 作为运行时特殊关系，被大量逻辑直接使用
- QQ / OneBot `userId` 直接被当作用户主键保存到 `users.json`
- session id 同时承担“消息入口标识”和“参与者身份标识”

这导致几个问题：

- WebUI 创建会话必须手填用户 id，语义不自然
- `.own` 绑定把 owner 长期绑死在某个 QQ 号上
- 后续扩展多接口、同协议多实例、多平台用户合并时，现有主键设计会直接冲突

本次重构目标是把“内部用户”“外部身份”“会话入口”三者拆开。

## 目标

- `owner` 成为稳定内部用户 id，不再依赖 QQ 号
- 普通用户也改为不带平台语义的内部用户 id
- 外部平台账号通过独立身份绑定表映射到内部用户
- session id 仅表示消息入口，不再表示内部用户
- WebUI 新建会话不再要求手填用户 id，直接创建 owner Web 会话
- `.own` 改为把当前外部身份绑定到内部用户 `owner`
- 不保留长期兼容旧模型的代码

## 非目标

- 不实现通用旧数据迁移框架
- 不实现“一个内部用户绑定多个外部身份”
- 不实现后台用户合并 UI
- 不在本次重构里引入新的平台接入

## 设计概览

系统内存在三类标识：

- 内部用户 id：用于用户资料、记忆、关系判断
- 外部身份：用于描述某个接口上的某个外部账号
- session id：用于描述消息从哪个入口进入系统

三者必须完全分离。

## 内部用户模型

### 内部用户 id

- `owner` 是固定保留 id
- 普通用户使用 opaque id，格式为 `u_<ulid>`
- 内部用户 id 不包含平台信息，不从外部账号推导

### 用户数据存储

`users.json` 只存内部用户数据，不再直接存 QQ 号用户键。

保留现有用户资料与记忆字段：

- `userId`
- `preferredAddress`
- `gender`
- `residence`
- `timezone`
- `occupation`
- `profileSummary`
- `relationshipNote`
- `memories`
- `specialRole`
- `createdAt`

`relationship` 运行时规则改为：

- `userId === "owner"` 时为 `owner`
- 其他内部用户统一为 `known`

## 外部身份绑定模型

### 新增存储

新增 `user-identities.json`，用于保存外部身份到内部用户的绑定关系。

建议记录结构：

```json
[
  {
    "channelId": "qqbot",
    "scope": "private_user",
    "externalId": "123456",
    "internalUserId": "owner",
    "createdAt": 1760000000000
  }
]
```

字段含义：

- `channelId`：接口名，例如 `qqbot`
- `scope`：当前仅需要 `private_user`
- `externalId`：平台提供的用户 id
- `internalUserId`：内部用户 id
- `createdAt`：绑定创建时间

### 约束

本次只支持一对一绑定：

- 同一个 `(channelId, scope, externalId)` 只能绑定一个内部用户
- 同一个 `internalUserId` 只能拥有一个外部身份绑定

如果后续支持多平台合并，再放宽第二条约束。

### 运行时职责

新增 `userIdentityStore`，负责：

- 根据外部身份查找内部用户
- 为新普通用户创建内部用户并建立绑定
- 将某个外部身份绑定到 `owner`
- 校验一对一绑定冲突

## Session 模型

### Session id 新规则

session id 表示消息入口，统一改为：

`<channelId>:<p|g>:<platformUserId|groupId>`

例如：

- `qqbot:p:123456`
- `qqbot:g:987654`

说明：

- `p` 表示私聊
- `g` 表示群聊
- 末尾 id 继续使用平台原始 id，不使用内部用户 id

### Session 数据语义

私聊 session：

- `id = qqbot:p:123456`
- `participantUserId = owner` 或 `u_<ulid>`

群聊 session：

- `id = qqbot:g:987654`
- 群不是用户，不应继续复用 `participantUserId` 表达群身份

本次建议把 session 参与者字段拆成更准确的结构，避免“用户 id / 群 id”继续混用。

建议方向：

- 私聊保存内部用户参与者
- 群聊保存群参与者引用，不再伪装成用户 id

如果当前实现成本过高，允许先引入更中性的 participant 结构，再逐步替换旧命名。

## Owner 绑定语义

`.own` 的新语义：

- 仅允许在对应接口私聊中执行
- 不再把某个 QQ 号本身设为 owner 用户主键
- 而是把当前外部身份绑定到内部用户 `owner`

执行流程：

1. 校验当前仍处于 owner 初始化阶段
2. 确认调用来源为私聊
3. 解析当前 `channelId` 与外部 `userId`
4. 创建或确保内部用户 `owner`
5. 在 `user-identities.json` 中写入绑定
6. 推进初始化状态

## WebUI 会话创建

WebUI 创建会话改为固定创建 owner Web 会话：

- 删除手动输入 `participantUserId`
- internal API 创建 Web session 时直接使用 `owner`
- `participantLabel` 仍可保留为可选展示字段

这会让 WebUI 语义与“owner 是系统后台操作者”保持一致。

## 消息入站解析

OneBot 入站消息处理改为先解析外部身份，再进入用户层。

流程：

1. 根据接口上下文得到 `channelId`
2. 从消息得到外部 `userId`
3. 使用 `userIdentityStore` 查找已绑定内部用户
4. 若存在绑定，使用绑定得到的内部用户 id
5. 若不存在绑定：
   - 若是 owner 初始化流程，仅允许 `.own` 进入特殊处理
   - 否则为普通用户新建 `u_<ulid>` 并建立一对一绑定
6. 后续 `userStore`、memory、prompt、tools 一律只使用内部用户 id

## 白名单模型

`whitelist.json` 收敛为纯白名单存储：

- `users`
- `groups`

不再保存 `ownerId`。

owner 识别与 owner 绑定不再通过 whitelist 处理，而改为：

- owner 关系：看内部用户 id 是否为 `owner`
- owner 外部入口：看身份绑定是否指向 `owner`

## 本次数据处理范围

本次不写通用旧数据迁移代码。

仅处理当前本地两个 instance 中的 owner 相关数据，使其进入新模型。

处理范围：

- 读取旧 owner 绑定信息
- 将旧 owner 资料与记忆并入内部用户 `owner`
- 为 owner 写入新的外部身份绑定
- 将 owner 相关私聊 session 切到新 session id 规则
- 清理白名单中的 owner 绑定语义

不处理范围：

- 普通用户历史数据自动迁移
- 任意旧版本数据格式的通用修复

## 实施顺序

### 1. 身份层重构

- 新增 `userIdentityStore`
- 调整 `userStore` 仅处理内部用户 id
- 去掉 `whitelistStore` 中的 owner 绑定职责

### 2. Session 标识重构

- 改造 session id 解析与生成
- 更新 session persistence
- 调整 session display 与 participant 语义

### 3. 入站消息链路改造

- 在消息上下文构建前解析外部身份
- owner 初始化改用绑定模型
- 普通用户改为自动分配内部用户 id

### 4. WebUI 与 internal API 改造

- 删除手填用户 id
- Web 会话固定使用 `owner`

### 5. 本地 owner 数据迁移

- 先备份两个 instance
- 一次性搬迁 owner 资料、绑定与相关 session

### 6. 测试与文档收尾

- 更新 identity / session / messaging / internalApi / webui 测试
- 更新 README 与相关文档

## 风险与注意事项

- 需要逐个核对持久化结构里哪些字段表达内部用户，哪些字段表达外部平台身份
- 群聊 participant 语义当前不清晰，本次必须至少做一次收敛
- owner 本地搬迁必须先备份，避免覆盖现有记忆
- 新旧 session id 并存阶段不应长期存在；一旦切换，应收敛到新规则

## 验收标准

- WebUI 可直接创建 owner Web 会话，无需手填用户 id
- `.own` 执行后，owner 绑定记录写入 `user-identities.json`
- `users.json` 中 owner 始终为 `owner`，不再出现“QQ 号即 owner 主键”的设计
- 新创建的私聊 session id 采用 `<channelId>:p:<platformUserId>`
- 普通新用户进入系统后会生成内部用户 id，而不是直接使用平台 id
- 白名单不再承担 owner 存储职责

