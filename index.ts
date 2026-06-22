import { mkdir, appendFile, writeFile, readFile, rename, readdir } from "fs/promises"
import { join, dirname, basename } from "path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { startAutoUpdate } from "./updateOps"

async function debugLog(directory: string, msg: string) {
  if (process.env.PROMPT_RECORDER_DEBUG !== "1" && process.env.PROMPT_RECORDER_DEBUG !== "true") return
  const time = new Date().toISOString()
  const logLine = `[${time}] ${msg}\n`
  try {
    const logDir = join(directory, ".prompts-log")
    await mkdir(logDir, { recursive: true })
    await appendFile(join(logDir, "log.txt"), logLine)
  } catch (e) {
    console.error("debugLog failed:", e)
  }
}

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f\u200B-\u200F\u2028-\u202E\uFEFF]/g

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

function formatDate(date: Date) {
  const yyyy = date.getFullYear().toString()
  const MM = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const HH = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return { yyyy, MM, dd, HH, mm, ss }
}

const FILE_EXT = ".txt"

async function findSessionFile(directory: string, sessionID: string): Promise<string | undefined> {
  return scanDirForSession(join(directory, ".prompts"), sessionID)
}

async function scanDirForSession(dir: string, sessionID: string): Promise<string | undefined> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  for (const name of names) {
    const fullPath = join(dir, name)
    try {
      const content = await readFile(fullPath, "utf-8")
      if (content.includes(`SessionID: ${sessionID}`)) return fullPath
    } catch {
      if (name.endsWith(FILE_EXT)) continue
      const found = await scanDirForSession(fullPath, sessionID)
      if (found) return found
    }
  }
  return undefined
}

const OpenCodePromptRecorder: Plugin = async (ctx) => {
  startAutoUpdate(ctx, true)
  const { directory } = ctx
  const sessionTitleMap = new Map<string, { title: string; time: number }>()
  const messageRoleMap = new Map<string, { role: string; time: number }>()
  const processedMessageKeys = new Map<string, number>()
  const taskSessionIds = new Map<string, number>()
  const CACHE_MAX_IDLE_MS = 24 * 60 * 60 * 1000
  const CACHE_MAX_SIZE = 200
  const MAX_MAP_SIZE = 2000
  const MAX_MAP_AGE = 24 * 60 * 60 * 1000
  const PENDING_RENAME_MAX_AGE = 60 * 60 * 1000
  const sessionFileCache = new Map<string, { filepath: string; time: number }>()
  const pendingRenames = new Map<string, { title: string; time: number }>()
  const pendingSdkTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const ASSISTANT_FLUSH_DELAY = 3000
  const assistantMetaMap = new Map<string, { modelID: string; providerID: string; tokens: any; time: any; cost: number }>()
  const assistantTextBuffer = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()

  function pruneCache() {
    if (sessionFileCache.size < CACHE_MAX_SIZE) return
    const now = Date.now()
    for (const [k, v] of sessionFileCache) {
      if (now - v.time > CACHE_MAX_IDLE_MS) sessionFileCache.delete(k)
    }
  }

  function pruneMaps() {
    const now = Date.now()
    if (processedMessageKeys.size > MAX_MAP_SIZE) {
      for (const [k, t] of processedMessageKeys) {
        if (now - t > MAX_MAP_AGE) processedMessageKeys.delete(k)
      }
    }
    if (messageRoleMap.size > MAX_MAP_SIZE) {
      for (const [k, v] of messageRoleMap) {
        if (now - v.time > MAX_MAP_AGE) messageRoleMap.delete(k)
      }
    }
    if (taskSessionIds.size > MAX_MAP_SIZE) {
      for (const [k, t] of taskSessionIds) {
        if (now - t > MAX_MAP_AGE) taskSessionIds.delete(k)
      }
    }
    if (sessionTitleMap.size > MAX_MAP_SIZE) {
      for (const [k, v] of sessionTitleMap) {
        if (now - v.time > MAX_MAP_AGE) sessionTitleMap.delete(k)
      }
    }
    if (pendingRenames.size > 0) {
      for (const [k, v] of pendingRenames) {
        if (now - v.time > PENDING_RENAME_MAX_AGE) pendingRenames.delete(k)
      }
    }
  }

  async function renameFileWithTitle(cached: { filepath: string; time: number }, title: string) {
    const dir = dirname(cached.filepath)
    const base = basename(cached.filepath)
    const prefix = base.match(/^(\d{10,12})-/)
    if (!prefix) return
    const newFilepath = join(dir, `${prefix[1]}-${sanitizeFilename(title)}${FILE_EXT}`)
    if (newFilepath === cached.filepath) return
    try {
      await rename(cached.filepath, newFilepath)
      cached.filepath = newFilepath
    } catch {
      const suffix = crypto.randomUUID().slice(0, 8)
      const fallbackPath = join(dir, `${prefix[1]}-${sanitizeFilename(title)}-${suffix}${FILE_EXT}`)
      try {
        await rename(cached.filepath, fallbackPath)
        cached.filepath = fallbackPath
      } catch (e) {
        console.error(`[prompt-recorder] rename failed: ${cached.filepath}`, e)
      }
    }
  }

  async function appendToSessionFile(sessionID: string, content: string, customHeader?: string) {
    const now = new Date()
    const { yyyy, MM, dd, HH, mm, ss } = formatDate(now)
    const yy = yyyy.slice(-2)
    const timeTitle = customHeader ?? `============ ${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss} ============`
    const entry = `\n\n${timeTitle}\n\n${content}`

    const cached = sessionFileCache.get(sessionID)
    if (cached) {
      cached.time = Date.now()
      await appendFile(cached.filepath, entry)
      return
    }

    const foundPath = await findSessionFile(directory, sessionID)
    if (foundPath) {
      sessionFileCache.set(sessionID, { filepath: foundPath, time: Date.now() })
      await appendFile(foundPath, entry)
      return
    }

    const promptDir = join(directory, ".prompts", yyyy, MM, dd)
    await mkdir(promptDir, { recursive: true })
    const topic = sanitizeFilename(sessionTitleMap.get(sessionID)?.title ?? content)
    const filename = `${yy}${MM}${dd}${HH}${mm}${ss}-${topic}${FILE_EXT}`
    const filepath = join(promptDir, filename)
    const sessionHeader = `============ SessionID: ${sessionID} ============`
    await writeFile(filepath, `${sessionHeader}\n\n${timeTitle}\n\n${content}`)
    sessionFileCache.set(sessionID, { filepath, time: Date.now() })
    pruneCache()

    const pendingRename = pendingRenames.get(sessionID)
    if (pendingRename) {
      pendingRenames.delete(sessionID)
      const newEntry = sessionFileCache.get(sessionID)
      if (newEntry) {
        await renameFileWithTitle(newEntry, pendingRename.title)
      }
    }

    const existingTimer = pendingSdkTimers.get(sessionID)
    if (existingTimer) clearTimeout(existingTimer)
    const timer = setTimeout(async () => {
      pendingSdkTimers.delete(sessionID)
      try {
        const res = await ctx.client.session.get({ path: { id: sessionID } })
        const fetchedTitle = (res as any)?.data?.title
        if (!fetchedTitle) return
        const oldTitle = sessionTitleMap.get(sessionID)?.title
        if (fetchedTitle === oldTitle) return
        sessionTitleMap.set(sessionID, { title: fetchedTitle, time: Date.now() })
        const cachedEntry = sessionFileCache.get(sessionID)
        if (cachedEntry) {
          await renameFileWithTitle(cachedEntry, fetchedTitle)
        }
      } catch {
        // ignore
      }
    }, 5000)
    pendingSdkTimers.set(sessionID, timer)
  }

  async function handleMessageUpdated(event: { properties: any }) {
    const info = event.properties.info as any
    const id = info?.id
    const role = info?.role || info?.message?.role
    if (id && (role === "user" || role === "assistant")) {
      messageRoleMap.set(id, { role, time: Date.now() })
    }
    if (id && role === "assistant" && info.tokens) {
      const existing = assistantMetaMap.get(id)
      assistantMetaMap.set(id, {
        modelID: info.modelID ?? existing?.modelID,
        providerID: info.providerID ?? existing?.providerID,
        tokens: info.tokens ?? existing?.tokens,
        time: info.time ?? existing?.time,
        cost: info.cost ?? existing?.cost,
      })
    }
  }

  async function handleMessagePartUpdated(event: { type: string; properties: any }) {
    const part = (event.properties as any).part
    if (part?.type === "tool" && part?.tool === "task") {
      const stateMetadata = part.state?.metadata ?? part.metadata
      if (stateMetadata) {
        const childId: string | undefined = stateMetadata.sessionId ?? stateMetadata.sessionID
        if (childId) {
          taskSessionIds.set(childId, Date.now())
          await debugLog(directory, `[prompt-recorder] tracked task session: ${childId}`)
        }
      }
    }
    if (part?.type === "tool" && part?.tool === "question" && part?.state?.status === "completed") {
      const sessionID = part.sessionID
      if (!sessionID) return

      const questions: any[] = part.state.input?.questions ?? []
      if (!questions.length) return
      const answers: string[][] = part.state.metadata?.answers ?? []

      const lines: string[] = []
      lines.push("[Question Tool]")
      questions.forEach((q: any, i: number) => {
        const qText = q.question || q.header || `Question ${i + 1}`
        lines.push(`Q: ${qText}`)
        if (q.options?.length) {
          lines.push(`  Options: ${q.options.map((o: any) => o.label).join(", ")}`)
        }
        const aText = answers[i]?.join(", ") || "(unanswered)"
        lines.push(`A: ${aText}`)
        if (i < questions.length - 1) lines.push("")
      })

      const text = lines.join("\n")

      const dedupeKey = `question:${part.callID || part.messageID || sessionID}`
      if (processedMessageKeys.has(dedupeKey)) return
      processedMessageKeys.set(dedupeKey, Date.now())
      pruneMaps()

      if (taskSessionIds.has(sessionID)) {
        await debugLog(directory, `[prompt-recorder] skipped task session: ${sessionID}`)
        return
      }

      await debugLog(directory, `[prompt-recorder] recorded question tool Q&A: sessionID=${sessionID}, questions=${questions.length}`)
      await appendToSessionFile(sessionID, text)
      return
    }

    if (part?.type !== "text" || !part?.text) return

    if (part.synthetic || part.ignored) return

    const sessionID = part.sessionID
    const messageID = part.messageID
    const text = part.text

    if (!sessionID) return

    let role = messageRoleMap.get(messageID)?.role
    if (!role) role = part.message?.role
    if (!role) role = (event.properties as any).info?.role
    if (!role) role = (event.properties as any).info?.message?.role

    if (role === "user") {
      if (isSystemInjected(text)) {
        await debugLog(directory, `[prompt-recorder] filtered system-injected: sessionID=${sessionID}`)
        return
      }

      const dedupeKey = messageID ? `${messageID}:${text}` : `${sessionID}:${text}`
      if (processedMessageKeys.has(dedupeKey)) return
      processedMessageKeys.set(dedupeKey, Date.now())
      pruneMaps()

      if (taskSessionIds.has(sessionID)) {
        await debugLog(directory, `[prompt-recorder] skipped task session: ${sessionID}`)
        return
      }

      await debugLog(directory, `[prompt-recorder] event=${event.type}, role=${role}, sessionID=${sessionID}, textLength=${text.length}, textPreview=${text.substring(0, 50)}`)

      await appendToSessionFile(sessionID, text)
    } else if (role === "assistant") {
      if (taskSessionIds.has(sessionID)) {
        await debugLog(directory, `[prompt-recorder] skipped task session: ${sessionID}`)
        return
      }

      await handleAssistantTextPart(messageID, sessionID, text)
    }
  }

  async function handleAssistantTextPart(messageID: string, sessionID: string, text: string) {
    const dedupeKey = `assistant:${messageID}`
    if (processedMessageKeys.has(dedupeKey)) return

    const existing = assistantTextBuffer.get(messageID)
    if (existing) {
      if (existing.text === text) return
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(async () => {
      assistantTextBuffer.delete(messageID)
      processedMessageKeys.set(dedupeKey, Date.now())
      pruneMaps()
      await flushAssistantResponse(messageID, sessionID)
    }, ASSISTANT_FLUSH_DELAY)

    assistantTextBuffer.set(messageID, { text, timer })
  }

  async function flushAssistantResponse(messageID: string, sessionID: string) {
    const buf = assistantTextBuffer.get(messageID)
    if (!buf) return

    const meta = assistantMetaMap.get(messageID)

    const now = new Date()
    const { yyyy, MM, dd, HH, mm, ss } = formatDate(now)

    let header = `============ ${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`

    if (meta) {
      const modelStr = meta.modelID ? `${meta.providerID}/${meta.modelID}` : ''
      if (modelStr) header += ` | Model: ${modelStr}`

      if (meta.tokens) {
        header += ` | In: ${meta.tokens.input} | Out: ${meta.tokens.output}`
        if (meta.tokens.reasoning) {
          header += ` | R: ${meta.tokens.reasoning}`
        }
      }

      if (meta.time?.completed && meta.time?.created) {
        const durationMs = meta.time.completed - meta.time.created
        if (meta.tokens?.output && durationMs > 0) {
          const tps = (meta.tokens.output / (durationMs / 1000)).toFixed(1)
          header += ` | TPS: ${tps}`
        }
      }
    }

    header += ` ============`

    await debugLog(directory, `[prompt-recorder] recorded assistant response: messageID=${messageID}, sessionID=${sessionID}, textLength=${buf.text.length}`)

    await appendToSessionFile(sessionID, buf.text, header)
  }

  async function handleSessionCreated(event: { properties: any }) {
    const info = (event.properties as any).info
    if (info?.id && info?.title) {
      sessionTitleMap.set(info.id, { title: info.title, time: Date.now() })
      const cached = sessionFileCache.get(info.id)
      if (cached) {
        await renameFileWithTitle(cached, info.title)
      }
    }
  }

  async function handleSessionUpdated(event: { properties: any }) {
    const info = (event.properties as any).info
    if (info?.id && info?.title) {
      const oldTitle = sessionTitleMap.get(info.id)?.title
      sessionTitleMap.set(info.id, { title: info.title, time: Date.now() })
      if (oldTitle !== info.title) {
        const cached = sessionFileCache.get(info.id)
        if (cached) {
          await renameFileWithTitle(cached, info.title)
        } else {
          pendingRenames.set(info.id, { title: info.title, time: Date.now() })
        }
      }
    }
  }

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "message.updated":
          await handleMessageUpdated(event)
          break
        case "message.part.updated":
          await handleMessagePartUpdated(event)
          break
        case "session.created":
          await handleSessionCreated(event)
          break
        case "session.updated":
          await handleSessionUpdated(event)
          break
      }
    }
  }
}

export default OpenCodePromptRecorder
