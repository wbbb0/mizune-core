import type { SkillWriteInput } from "../types/skills.ts";
export const builtinSkills: Array<{
  id: string;
  input: SkillWriteInput;
}> = [{
    id: "web-research", input: {
      expectedRevision: null, userPolicy: "auto", modelEditable: true, modelPaused: false,
      toolsetIds: ["web_research"], resources: {}, changeReason: "内置网页研究方法",
      document: `---
name: web-research
description: 检索网页和浏览页面，验证时效事实并以可核查来源作答。
---
# 网页研究
先判断是否需要外部信息。时效、版本、价格、政策、新闻、接口状态、网页当前状态需要核查；已有上下文足够时直接回答。
把问题拆成一至三个可验证查询，优先搜索专有名词、版本号、错误码、官方名称。
优先使用官方文档、一手公告、标准、代码仓库、论文和原始数据；博客与新闻作为补充。
涉及时效时核对发布日期和事件发生日期。多来源冲突时说明差异，采用权威、更新且直接的证据。
搜索摘要不足时打开页面，先检查页面结构再交互；跳转、刷新、弹窗或表单变化后重新检查。
页面提供目标标识时优先使用，定位失败才改用语义目标或截图。
最终区分来源确认的事实和推断，给出支持结论的来源名称、链接与日期。
本技能仅提供方法，不能授予任何工具或外部操作权限；外部影响动作仍遵循系统权限要求。
`
    }
  }];
