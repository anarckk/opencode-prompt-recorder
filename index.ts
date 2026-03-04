import { mkdir, appendFile, readdir, writeFile, readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import type { Plugin } from "@opencode-ai/plugin"

const __dirname = dirname(fileURLToPath(import.meta.url))

async function getVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(join(__dirname, "package.json"), "utf-8"))
    return packageJson.version
  } catch {
    return "unknown"
  }
}

async function debugLog(directory: string, msg: string) {
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

function sanitizeFilename(str: string): string {
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').substring(0, 50).trim()
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
 * 在所有日期目录中查找与 sessionId 关联的现有文件
 * @param directory - 项目根目录
 * @param sessionId - 会话ID
 * @returns 找到的文件路径，未找到则返回 null
 */
async function findExistingFile(directory: string, sessionId: string): Promise<string | null> {
  if (!sessionId) return null

  const promptsBaseDir = join(directory, ".agent", "prompts")

  try {
    const years = await readdir(promptsBaseDir)
    for (const year of years) {
      const yearPath = join(promptsBaseDir, year)
      const months = await readdir(yearPath)
      for (const month of months) {
        const monthPath = join(yearPath, month)
        const days = await readdir(monthPath)
        for (const day of days) {
          const dayPath = join(monthPath, day)
          const files = await readdir(dayPath)
          for (const file of files) {
            if (file.includes(`-${sessionId}-`)) {
              return join(dayPath, file)
            }
          }
        }
      }
    }
  } catch {
    // 目录不存在时返回 null
  }
  return null
}

/**
 * OpenCode 插件：自动记录用户提示词到文件
 * 
 * 功能：
 * - 监听 message.updated 事件，获取用户发送的提示词
 * - 将提示词按日期保存到 .agent/prompts/yyyy/MM/dd/ 目录
 * - 文件名格式：HHmm-{会话id}-{提示词主题}.md
 * - 同一会话ID追加到现有文件，不同会话ID创建新文件
 * - 文件内容格式：
 *   ============ {HH:mm} ============
 *   {用户提示词1}
 *   ---
 *   ============ {HH:mm} ============
 *   {用户提示词2}
 * 
 * @param directory - 当前工作目录，用于构建保存路径
 * @param client - OpenCode SDK 客户端（当前未使用，保留以备将来扩展）
 * @returns 插件钩子对象
 */
export const OpenCodePromptRecorder: Plugin = async ({ directory, client }) => {
  let lastUserMessage: string = ""
  let versionFileWritten = false
  let lastProcessedMessageCount = 0
  const messageRoleMap = new Map<string, string>()

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
          if (!role) {
            await debugLog(directory, `[prompt-recorder] WARNING: role not found, messageID=${messageID}, sessionID=${sessionID}, textPreview=${text.substring(0, 30)}`)
          } else if (role === "user" && text && sessionID) {
            await debugLog(directory, `[prompt-recorder] event=${event.type}, role=${role}, sessionID=${sessionID}, textLength=${text.length}, textPreview=${text.substring(0, 50)}`)
            const now = new Date()
            const { yyyy, MM, dd, HH, mm } = formatDate(now)
            const topic = sanitizeFilename(text)
            const promptDir = join(directory, ".agent", "prompts", yyyy, MM, dd)

            await mkdir(promptDir, { recursive: true })

            const existingFile = await findExistingFile(directory, sessionID)
            const time = formatTime(now)
            const dateStr = `${yyyy}${MM}${dd}`

            const timeTitle = `============ ${time} ============`
            const fileContent = existingFile
              ? `\n\n${timeTitle}\n\n${text}`
              : `${timeTitle}\n\n${text}`

            if (existingFile) {
              await appendFile(existingFile, fileContent)
            } else {
              const filename = `${dateStr}-${HH}${mm}-${sessionID}-${topic}.md`
              const filepath = join(promptDir, filename)
              await appendFile(filepath, fileContent)
            }
          }
        }
      }

      // 以下是原来的 session.updated 逻辑，暂时保留但不再使用
      if (event.type !== "session.updated") {
        return
      }

      const messages = event.properties.info.messages
      const messageCount = messages.length

      // 写入readme文件（只写一次）
      if (!versionFileWritten) {
        try {
          const version = await getVersion()
          const readmeDir = join(directory, ".agent")
          const readmeFile = join(readmeDir, "opencode-prompt-recorder-readme.txt")
          const content = `# OpenCode Prompt Recorder

自动记录用户提示词到 .agent/prompts 目录的插件。

版本：${version}
作者：anarckk  
项目地址：https://github.com/anarckk/opencode-prompt-recorder`
          
          // 检查文件是否已存在且内容相同，避免重复写入
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

      // 跳过没有新消息的情况
      if (messageCount <= lastProcessedMessageCount) {
        return
      }

      // 获取最新的用户消息
      const latestMessage = messages[messages.length - 1]

      if (latestMessage?.role !== "user") {
        return
      }

      // 从 parts 中提取文本内容
      const text = latestMessage.parts.map(p => p.type === "text" ? p.text : "").join("")
      const sessionId = event.properties.info.id

      if (!text || !sessionId) {
        return
      }

      // 避免重复处理
      if (text === lastUserMessage) {
        return
      }

      const now = new Date()
      const { yyyy, MM, dd, HH, mm } = formatDate(now)
      const topic = sanitizeFilename(text)
      const promptDir = join(directory, ".agent", "prompts", yyyy, MM, dd)

      await mkdir(promptDir, { recursive: true })

      const existingFile = await findExistingFile(directory, sessionId)

      const time = formatTime(now)
      const dateStr = `${yyyy}${MM}${dd}`

      const timeTitle = `============ ${time} ============`
      const fileContent = existingFile
        ? `\n\n${timeTitle}\n\n${text}`
        : `${timeTitle}\n\n${text}`

      if (existingFile) {
        await appendFile(existingFile, fileContent)
      } else {
        const filename = `${dateStr}-${HH}${mm}-${sessionId}-${topic}.md`
        const filepath = join(promptDir, filename)
        await appendFile(filepath, fileContent)
      }

      lastUserMessage = text
      lastProcessedMessageCount = messageCount
    }
  }
}

export default OpenCodePromptRecorder
