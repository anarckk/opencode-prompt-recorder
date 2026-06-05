import { mkdir, appendFile, writeFile, readFile, rename } from "fs/promises"
import { join, dirname, basename } from "path"
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
 * OpenCode 插件：自动记录用户提示词到文件
 * 
 * 功能：
 * - 监听 message.updated 事件，获取用户发送的提示词
 * - 将提示词按日期保存到 .agent/prompts/yyyy/MM/dd/ 目录
 * - 同一 session 的消息合并到同一个文件，文件以会话标题命名，标题不存在时回退到首条消息主题
 * - 文件名格式：yyMMddHHmm-{topic}.txt
 * - 文件内容格式：
 *   ============ SessionID: {sessionID} ============
 *   ============ {yyyy-MM-dd HH:mm} ============
 *   {用户提示词1}
 *
 *   ============ {yyyy-MM-dd HH:mm} ============
 *   {用户提示词2}
 * 
 * @param ctx - 插件上下文（包含 directory 和 client）
 * @returns 插件钩子对象
 */
export const OpenCodePromptRecorder: Plugin = async (ctx) => {
  startAutoUpdate(ctx, true)
  const { directory } = ctx
  let versionFileWritten = false
  const sessionTitleMap = new Map<string, string>()
  const messageRoleMap = new Map<string, string>()
  const processedMessageKeys = new Set<string>()
  const taskSessionIds = new Set<string>()
  const CACHE_MAX_IDLE_MS = 24 * 60 * 60 * 1000
  const CACHE_MAX_SIZE = 200
  const sessionFileCache = new Map<string, { filepath: string; time: number }>()
  const pendingRenames = new Map<string, string>()
  function pruneCache() {
    if (sessionFileCache.size < CACHE_MAX_SIZE) return
    const now = Date.now()
    for (const [k, v] of sessionFileCache) {
      if (now - v.time > CACHE_MAX_IDLE_MS) sessionFileCache.delete(k)
    }
  }

  async function renameFileWithTitle(cached: { filepath: string; time: number }, title: string) {
    const dir = dirname(cached.filepath)
    const base = basename(cached.filepath)
    const prefix = base.match(/^(\d{10})-/)
    if (!prefix) return
    const newFilepath = join(dir, `${prefix[1]}-${sanitizeFilename(title)}.txt`)
    if (newFilepath === cached.filepath) return
    try {
      await rename(cached.filepath, newFilepath)
      cached.filepath = newFilepath
    } catch {
      // ignore
    }
  }

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
        if (part?.type === "tool" && part?.tool === "task") {
          const stateMetadata = part.state?.metadata ?? part.metadata
          if (stateMetadata) {
            const childId: string | undefined = stateMetadata.sessionId ?? stateMetadata.sessionID
            if (childId) {
              taskSessionIds.add(childId)
              await debugLog(directory, `[prompt-recorder] tracked task session: ${childId}`)
            }
          }
        }
        if (part?.type === "text" && part?.text) {
          // 跳过 synthetic 部件（海马体等插件注入的系统提示）和 ignored 部件（仅用户可见的通知）
          if (part.synthetic || part.ignored) {
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

            const now = new Date()
            const { yyyy, MM, dd, HH, mm } = formatDate(now)
            const promptsBaseDir = join(directory, ".agent", "prompts")

            // 子 agent（task 工具）的提示词存入 task/ 子目录，避免碎片化
            const isTaskSession = taskSessionIds.has(sessionID)
            const promptDir = isTaskSession
              ? join(promptsBaseDir, "task", yyyy, MM, dd)
              : join(promptsBaseDir, yyyy, MM, dd)

            await mkdir(promptDir, { recursive: true })

            const yy = yyyy.slice(-2)

            const timeTitle = `============ ${yyyy}-${MM}-${dd} ${HH}:${mm} ============`

            // 同一 session 的消息合并到同一个文件
            const cached = sessionFileCache.get(sessionID)
            if (cached) {
              cached.time = Date.now()
              await appendFile(cached.filepath, `\n\n${timeTitle}\n\n${text}`)
            } else {
              const topic = sanitizeFilename(sessionTitleMap.get(sessionID) ?? text)
              const filename = `${yy}${MM}${dd}${HH}${mm}-${topic}.txt`
              const filepath = join(promptDir, filename)
              const sessionHeader = `============ SessionID: ${sessionID} ============`
              await writeFile(filepath, `${sessionHeader}\n\n${timeTitle}\n\n${text}`)
              sessionFileCache.set(sessionID, { filepath, time: Date.now() })
              pruneCache()

              const pendingTitle = pendingRenames.get(sessionID)
              if (pendingTitle) {
                pendingRenames.delete(sessionID)
                const newEntry = sessionFileCache.get(sessionID)
                if (newEntry) {
                  await renameFileWithTitle(newEntry, pendingTitle)
                }
              }

              setTimeout(async () => {
                try {
                  const res = await ctx.client.session.get({ path: { id: sessionID } })
                  const fetchedTitle = res?.data?.title
                  if (!fetchedTitle) return
                  const oldTitle = sessionTitleMap.get(sessionID)
                  if (fetchedTitle === oldTitle) return
                  sessionTitleMap.set(sessionID, fetchedTitle)
                  const cachedEntry = sessionFileCache.get(sessionID)
                  if (cachedEntry) {
                    await renameFileWithTitle(cachedEntry, fetchedTitle)
                  }
                } catch {
                  // ignore
                }
              }, 5000)
            }
          }
        }
      }

      // session.created - 捕获会话标题
      if (event.type === "session.created") {
        const info = (event.properties as any).info
        if (info?.id && info?.title) {
          sessionTitleMap.set(info.id, info.title)
          const cached = sessionFileCache.get(info.id)
          if (cached) {
            await renameFileWithTitle(cached, info.title)
          }
        }
      }

      // session.updated - 捕获标题变更 + 写 readme 文件
      if (event.type === "session.updated") {
        const info = (event.properties as any).info
        if (info?.id && info?.title) {
          const oldTitle = sessionTitleMap.get(info.id)
          sessionTitleMap.set(info.id, info.title)
          if (oldTitle !== info.title) {
            const cached = sessionFileCache.get(info.id)
            if (cached) {
              await renameFileWithTitle(cached, info.title)
            } else {
              pendingRenames.set(info.id, info.title)
            }
          }
        }
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
}

export default OpenCodePromptRecorder
