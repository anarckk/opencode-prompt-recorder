import { mkdir, appendFile, writeFile, readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { startAutoUpdate } from "./updateOps"

const __dirname = dirname(fileURLToPath(import.meta.url))


async function debugLog(directory: string, msg: string) {
  if (process.env.PROMPT_RECORDER_DEBUG !== "1" && process.env.PROMPT_RECORDER_DEBUG !== "true") {
    return
  }
  const time = new Date().toISOString()
  const logLine = `[${time}] ${msg}\n`
  try {
    const logDir = join(directory, ".agent", "prompts-log")
    await mkdir(logDir, { recursive: true })
    await appendFile(join(logDir, "log.txt"), logLine)
  } catch (e) {
    console.error("debugLog failed:", e)
  }
}

async function getVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(join(__dirname, "package.json"), "utf-8"))
    return packageJson.version
  } catch {
    return "unknown"
  }
}

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

function sanitizeFilename(str: string): string {
  const firstLine = str.split('\n')[0].trim()
  const cleaned = firstLine.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  const result = cleaned.replace(ILLEGAL_FILENAME_CHARS, '').substring(0, 40).trim()
  return result || 'untitled'
}

function isSystemInjected(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('<system-reminder>') || trimmed.startsWith('<system>')
}

/**
 * 格式化日期为路径组件（年/月/日）和时间组件（时:分）
 * @param date - JavaScript Date 对象
 * @returns 包含 yyyy, MM, dd, HH, mm 的对象
 */
function formatDate(date: Date): { yyyy: string; MM: string; dd: string; HH: string; mm: string } {
  const yyyy = date.getFullYear().toString()
  const MM = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const HH = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return { yyyy, MM, dd, HH, mm }
}

/**
 * 格式化时间为 HH:mm 格式
 * @param date - JavaScript Date 对象
 * @returns 格式化后的时间字符串
 */
function formatTime(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
}

/**
 * OpenCode 插件：自动记录用户提示词到文件
 * 
 * 功能：
 * - 监听 message.updated 事件，获取用户发送的提示词
 * - 将提示词按日期保存到 .agent/prompts/yyyy/MM/dd/ 目录
 * - 同一 session 的消息合并到同一个文件，文件以首条消息主题命名
 * - 文件名格式：yyMMddHHmm-{提示词主题}.md
 * - 文件内容格式：
 *   ============ SessionID: {sessionID} ============
 *   ============ {HH:mm} ============
 *   {用户提示词1}
 *
 *   ============ {HH:mm} ============
 *   {用户提示词2}
 * 
 * @param ctx - 插件上下文（包含 directory 和 client）
 * @returns 插件钩子对象
 */
export const OpenCodePromptRecorder: Plugin = async (ctx) => {
  startAutoUpdate(ctx, true)
  const { directory, client } = ctx
  let versionFileWritten = false
  const messageRoleMap = new Map<string, string>()
  const processedMessageKeys = new Set<string>()
  let mainSessionId: string | null = null
  const sessionFileCache = new Map<string, string>()

  return {
    "event": async ({ event }) => {
      // 监听 message.updated 事件，记录 messageID -> role 的映射
      if (event.type === "message.updated") {
        const info = event.properties.info as any
        const role = info?.role || info?.message?.role
        if (info?.id && role) {
          messageRoleMap.set(info.id, role)
        }
      }

      // 监听 message.part.updated 事件，提取用户提示词
      if (event.type === "message.part.updated") {
        const part = (event.properties as any).part
        if (part?.type === "text" && part?.text) {
          // 跳过 synthetic 部件（海马体等插件注入的系统提示）
          if (part.synthetic) {
            return
          }

          const sessionID = part.sessionID
          const messageID = part.messageID
          const text = part.text

          // 尝试多种方式获取 role
          let role = messageRoleMap.get(messageID)
          if (!role) {
            role = part.message?.role
          }
          if (!role) {
            role = (event.properties as any).info?.role
          }
          if (!role) {
            role = (event.properties as any).info?.message?.role
          }

          // 只有用户消息才保存
          if (role === "user" && text && sessionID) {
            // 过滤系统注入内容（如 haimati 的 <system-reminder>）
            if (isSystemInjected(text)) {
              await debugLog(directory, `[prompt-recorder] filtered system-injected: sessionID=${sessionID}`)
              return
            }

            // 去重：使用 messageID + text 组合作为key，避免并发重复
            const dedupeKey = `${messageID}:${text}`
            if (processedMessageKeys.has(dedupeKey)) {
              return
            }
            processedMessageKeys.add(dedupeKey)

            await debugLog(directory, `[prompt-recorder] event=${event.type}, role=${role}, sessionID=${sessionID}, textLength=${text.length}, textPreview=${text.substring(0, 50)}`)

            // 记录主会话ID（第一条用户消息所属的会话）
            if (!mainSessionId) {
              mainSessionId = sessionID
            }

            const now = new Date()
            const { yyyy, MM, dd, HH, mm } = formatDate(now)
            const promptsBaseDir = join(directory, ".agent", "prompts")

            // 子 agent（task 工具）的提示词存入 task/ 子目录，避免碎片化
            const isTaskSession = sessionID !== mainSessionId && mainSessionId !== null
            const promptDir = isTaskSession
              ? join(promptsBaseDir, "task", yyyy, MM, dd)
              : join(promptsBaseDir, yyyy, MM, dd)

            await mkdir(promptDir, { recursive: true })

            const time = formatTime(now)
            const yy = yyyy.slice(-2)

            const timeTitle = `============ ${time} ============`

            // 同一 session 的消息合并到同一个文件
            let filepath = sessionFileCache.get(sessionID)
            if (filepath) {
              await appendFile(filepath, `\n\n${timeTitle}\n\n${text}`)
            } else {
              const topic = sanitizeFilename(text)
              const filename = `${yy}${MM}${dd}${HH}${mm}-${topic}.md`
              filepath = join(promptDir, filename)
              const sessionHeader = `============ SessionID: ${sessionID} ============`
              await writeFile(filepath, `${sessionHeader}\n\n${timeTitle}\n\n${text}`)
              sessionFileCache.set(sessionID, filepath)
            }
          }
        }
      }

      // session.updated 事件 - 只写 readme 文件
      if (event.type === "session.updated" && !versionFileWritten) {
        try {
          const version = await getVersion()
          const readmeDir = join(directory, ".agent")
          const readmeFile = join(readmeDir, "opencode-prompt-recorder-readme.txt")
          const content = `# OpenCode Prompt Recorder

自动记录用户提示词到 .agent/prompts 目录的插件。

版本：${version}
作者：anarckk  
项目地址：https://github.com/anarckk/opencode-prompt-recorder`

          try {
            const existing = await readFile(readmeFile, "utf-8")
            if (existing === content) {
              versionFileWritten = true
              return
            }
          } catch {
            // 文件不存在，继续写入
          }

          await mkdir(readmeDir, { recursive: true })
          await writeFile(readmeFile, content)
          versionFileWritten = true
        } catch (e) {
          // 忽略readme文件写入错误
        }
      }
    }
  }
}

export default OpenCodePromptRecorder
