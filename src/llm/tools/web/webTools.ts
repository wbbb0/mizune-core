import type { ToolDescriptor } from "../core/shared.ts";
export { webToolHandlers } from "./webToolHandlers.ts";

const isGoogleSearchToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.search.googleGrounding.enabled;
const isAliyunIqsToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.search.aliyunIqs.enabled;
const isBrowserToolEnabled: ToolDescriptor["isEnabled"] = (config) => config.browser.enabled;

export const webToolDescriptors: ToolDescriptor[] = [
  {
    definition: {
      type: "function",
      function: {
        name: "ground_with_google_search",
        description: "只在答案依赖最新外部网页信息时使用。对单个 query 做 Google grounding 搜索，返回摘要和可继续打开的 ref_ids。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isGoogleSearchToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "search_with_iqs_lite_advanced",
        description: "需要最新外部网页信息、但想要更可控的检索时使用。搜索阿里云 IQS LiteAdvanced，返回排序后的 ref_ids 和摘要。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            num_results: { type: "integer", minimum: 1, maximum: 50 },
            include_sites: { type: "array", items: { type: "string" }, maxItems: 100 },
            exclude_sites: { type: "array", items: { type: "string" }, maxItems: 100 },
            start_published_date: { type: "string", description: "格式 YYYY-MM-DD" },
            end_published_date: { type: "string", description: "格式 YYYY-MM-DD" },
            time_range: { type: "string" },
            include_main_text: { type: "boolean" },
            include_markdown_text: { type: "boolean" }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isAliyunIqsToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "list_browser_pages",
        description: "列出最近已知的浏览器页面 resources。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "open_page",
        description: "根据搜索 ref_id 或直接 URL 打开页面，返回 resource_id、可读文本、链接和可交互元素。开启新页面资源时应尽量提供 description，说明这个页面后续要做什么。",
        parameters: {
          type: "object",
          properties: {
            ref_id: { type: "string" },
            url: { type: "string" },
            description: { type: "string", description: "给这个页面资源的用途说明，便于后续复用时识别。" },
            line: { type: "integer", minimum: 1 }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "inspect_page",
        description: "按 resource_id 查看已打开页面，可跳到指定行或按 pattern 查找。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            line: { type: "integer", minimum: 1 },
            pattern: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "interact_with_page",
        description: "按 resource_id 操作当前页面。文本输入用 action=type 加 text；文件上传用 action=upload 加 file_paths（工作区相对路径）；优先使用 target_id，也可用 target 按 role/name/text/tag/type 语义定位；遇到 iframe 或元素定位失败时，可对 click/hover 传 coordinate.x 与 coordinate.y 做视口坐标操作。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            action: {
              type: "string",
              enum: ["click", "type", "upload", "select", "hover", "press", "check", "uncheck", "submit", "scroll_down", "scroll_up", "wait", "go_back", "go_forward", "reload"]
            },
            target_id: { type: "integer", minimum: 1 },
            target: {
              type: "object",
              properties: {
                role: { type: "string" },
                name: { type: "string" },
                text: { type: "string" },
                tag: { type: "string" },
                type: { type: "string" },
                href_contains: { type: "string" },
                index: { type: "integer", minimum: 1 }
              },
              additionalProperties: false
            },
            coordinate: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" }
              },
              required: ["x", "y"],
              additionalProperties: false
            },
            text: { type: "string", description: "action=type 时要输入的文本，保留空格与换行。" },
            value: { type: "string", description: "action=select 时的 option value；未提供时可回退到 text。" },
            key: { type: "string" },
            file_paths: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              description: "action=upload 时要上传的工作区相对路径，可传多个。"
            },
            wait_ms: { type: "integer", minimum: 1 },
            line: { type: "integer", minimum: 1 }
          },
          required: ["resource_id", "action"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "close_page",
        description: "按 resource_id 关闭已打开页面。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "capture_page_screenshot",
        description: "对当前已打开页面截图，返回截图对应的 workspace file_id / file_ref，并把截图附到下一轮视觉上下文里。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" }
          },
          required: ["resource_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "capture_element_screenshot",
        description: "按 target_id 对页面元素截图，适合验证码、登录框或局部区域。",
        parameters: {
          type: "object",
          properties: {
            resource_id: { type: "string" },
            target_id: { type: "integer", minimum: 1 }
          },
          required: ["resource_id", "target_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "download_asset",
        description: "把远程链接或当前网页元素对应的图片、视频、音频、文件下载进工作区；支持直接给 url，也支持给 resource_id 加 target_id。成功后返回 workspace file_id / file_ref / workspace_path。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            resource_id: { type: "string" },
            target_id: { type: "integer", minimum: 1 },
            source_name: { type: "string" },
            kind: {
              type: "string",
              enum: ["image", "animated_image", "video", "audio", "file"]
            }
          },
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "list_browser_profiles",
        description: "列出当前实例中可用的浏览器持久化 profile。",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "inspect_browser_profile",
        description: "查看一个浏览器 profile 的元数据和 origin 列表，不返回敏感 cookie 内容。",
        parameters: {
          type: "object",
          properties: {
            profile_id: { type: "string" }
          },
          required: ["profile_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "save_browser_profile",
        description: "立即保存当前浏览器 profile 的 cookies/localStorage/sessionStorage。",
        parameters: {
          type: "object",
          properties: {
            profile_id: { type: "string" }
          },
          required: ["profile_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  },
  {
    definition: {
      type: "function",
      function: {
        name: "clear_browser_profile",
        description: "清空一个浏览器 profile 的持久化状态，用于重新登录。",
        parameters: {
          type: "object",
          properties: {
            profile_id: { type: "string" }
          },
          required: ["profile_id"],
          additionalProperties: false
        }
      }
    },
    isEnabled: isBrowserToolEnabled
  }
];
