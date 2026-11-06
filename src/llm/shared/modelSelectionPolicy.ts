/** Shared semantic boundary for planner adapters; execution enforces tool effects separately. */
export const MODEL_SELECTION_SMALL_WHEN = "任务属于信息查询、普通交流或受控内容处理，影响局限于当前任务、已登记附件、受限临时工作区或明确数据对象；不涉及大模型条件，且没有明显复杂推理或精细质量要求。普通用户事实、偏好、草稿和日常会话状态更新，以及向当前聊天回复任务产物，不因写入而自动升级。";
export const MODEL_SELECTION_LARGE_WHEN = "需要执行代码或命令、向交互程序发送操作输入、控制运行环境，访问宿主机通用文件路径，改变权限、账号状态、长期执行规则、技能策略或有广泛后续影响的自动化，向其他主体或会话委派、转达、提交、发布或披露信息；或者需要复杂推理、多约束综合、跨材料冲突消解或精细表达。拟执行操作的作用范围或后果无法确认时也选此项。";
export const MODEL_SELECTION_INSTRUCTIONS = "按当前可见的任务要求、实际操作及作用范围选择模型档位，与工具可用性分开。任一大模型条件成立就选择 large，否则选择 small。工具数量、执行步骤、回答长度、一般不确定，以及尚未读取的代码、日志或工具结果本身不是升级理由。单次明确提醒可用小模型；重复或开放式自动执行，以及改变已有自动化策略使用大模型。资料不完整且无法判断任务档位时返回未判定，不编造证据。";
export const STATEFUL_RP_MODEL_SELECTION_RULE = "在 stateful_rp（沉浸状态角色扮演）模式下：若收到 # 开头的场外指令、涉及细腻身体感官与羞耻/情欲表里心理反差描写、高张力情感冲突、换装或私密道具互动、或 mode_signal 提示高张力/感官复杂时，优先选择 large；普通简短寒暄或轻量日常对话选择 small。";
