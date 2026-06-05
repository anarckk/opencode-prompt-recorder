import { mkdir, rm, appendFile, readdir, readFile } from "fs/promises"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const testDir = join(__dirname, "test-prompts-temp", ".agent", "prompts")

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---- test helpers: copies of relevant source functions ----

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g

function sanitizeFilename(str: string): string {
  const firstLine = str.split('\n')[0].trim()
  const cleaned = firstLine.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  const result = cleaned.replace(ILLEGAL_FILENAME_CHARS, '').substring(0, 40).trim()
  return result || 'untitled'
}

function isSystemInjected(text: string): boolean {
  return /^\s*<(system-reminder|system)>/.test(text)
}

async function findExistingFile(promptsBaseDir: string, sessionId: string): Promise<string | null> {
  if (!sessionId) return null

  async function searchDir(dir: string, skipTask: boolean): Promise<string | null> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (skipTask && entry.name === "task") continue
          const found = await searchDir(join(dir, entry.name), skipTask)
          if (found) return found
        } else if (entry.isFile() && entry.name.includes(`-${sessionId}-`)) {
          return join(dir, entry.name)
        }
      }
    } catch {
      // ignore
    }
    return null
  }

  const found = await searchDir(promptsBaseDir, true)
  if (found) return found

  const taskDir = join(promptsBaseDir, "task")
  return searchDir(taskDir, false)
}

// ---- existing tests (unchanged) ----

async function setup() {
  await mkdir(join(testDir, "2026", "02", "24"), { recursive: true })
  await mkdir(join(testDir, "2026", "02", "25"), { recursive: true })
}

async function cleanup() {
  await rm(dirname(testDir), { recursive: true, force: true })
}

async function testCrossDayMerge() {
  console.log("=== 测试：跨天会话合并 ===\n")

  const sessionId = "test-session-001"
  const topic = "测试主题"

  const day1File = join(testDir, "2026", "02", "24", `2350-${sessionId}-${topic}.md`)
  await appendFile(day1File, "============ 23:50 ============\n\n第一天23点50分的提示词")
  console.log(`创建文件: ${day1File}`)

  const existingFile = await findExistingFile(testDir, sessionId)
  assert(existingFile === day1File, `应找到文件 ${day1File}，实际: ${existingFile}`)
  console.log(`✅ 测试通过：找到跨天文件`)

  const content = await readFile(existingFile!, "utf-8")
  assert(content.includes("第一天23点50分"), "文件应包含Day1内容")
  console.log(`✅ 测试通过：文件内容正确`)
}

async function testCrossDayAppend() {
  console.log("=== 测试：跨天追加内容 ===\n")

  const sessionId = "test-session-002"
  const topic = "跨天主题"

  const day1File = join(testDir, "2026", "02", "24", `2350-${sessionId}-${topic}.md`)
  await appendFile(day1File, "============ 23:50 ============\n\n第一天23点50分的提示词")
  console.log(`Day1 创建文件: ${day1File}`)

  const existingFile = await findExistingFile(testDir, sessionId)
  assert(existingFile === day1File, `应找到文件 ${day1File}`)
  console.log(`✅ 测试通过：Day2 找到跨天文件`)

  const appendContent = `\n\n============ 00:03 ============\n\n第二天0点3分的提示词`
  await appendFile(existingFile!, appendContent)

  const finalContent = await readFile(existingFile!, "utf-8")

  assert(finalContent.includes("第一天23点50分"), "应包含Day1内容")
  assert(finalContent.includes("第二天0点3分"), "应包含Day2内容")
  console.log(`✅ 测试通过：跨天追加内容正确`)
}

async function testDifferentSession() {
  console.log("=== 测试：不同会话ID创建新文件 ===\n")

  const session1 = "session-001"
  const file1 = join(testDir, "2026", "02", "24", `1200-${session1}-主题A.md`)
  await mkdir(join(testDir, "2026", "02", "24"), { recursive: true })
  await appendFile(file1, "内容1")

  const result = await findExistingFile(testDir, "session-999")
  assert(result === null, `应返回 null，实际: ${result}`)
  console.log(`✅ 测试通过：不存在的session返回null`)
}

// ---- new tests for fixes ----

async function testSanitizeFilename() {
  console.log("=== 测试：sanitizeFilename 改进 ===\n")

  // 普通文本：取第一行
  const multiLine = "这是第一行\n这是第二行"
  assert(sanitizeFilename(multiLine) === "这是第一行", `应取第一行，实际: ${sanitizeFilename(multiLine)}`)
  console.log(`✅ 测试通过：多行文本取第一行`)

  // HTML标签剥离
  const withHtml = "探索项目 <system-reminder> 的使用"
  assert(sanitizeFilename(withHtml) === "探索项目 的使用", `应剥离HTML标签并合并空格，实际: "${sanitizeFilename(withHtml)}"`)
  console.log(`✅ 测试通过：剥离HTML标签`)

  // 非法字符处理
  const illegal = 'file:name/test\\bad|chars?*.md'
  const cleaned = sanitizeFilename(illegal)
  assert(!cleaned.includes(':'), `不应包含冒号: ${cleaned}`)
  assert(!cleaned.includes('\\'), `不应包含反斜杠: ${cleaned}`)
  assert(!cleaned.includes('|'), `不应包含竖线: ${cleaned}`)
  console.log(`✅ 测试通过：非法字符被移除 (${cleaned})`)

  // 空文本回退
  assert(sanitizeFilename('') === 'untitled', `空文本应回退到 untitled`)
  assert(sanitizeFilename('  ') === 'untitled', `空白文本应回退到 untitled`)
  console.log(`✅ 测试通过：空文本回退到 untitled`)

  // 截断到40字符
  const longText = '这是一个非常长的文件名用来测试截断功能是否正常工作超过四十个字符的长度'
  const truncated = sanitizeFilename(longText)
  assert(truncated.length <= 40, `应截断到40字符以内，实际${truncated.length}: ${truncated}`)
  console.log(`✅ 测试通过：截断到40字符 (${truncated.length} chars)`)
}

async function testIsSystemInjected() {
  console.log("=== 测试：isSystemInjected 系统注入检测 ===\n")

  assert(isSystemInjected('<system-reminder>\n# 海马体记忆使用说明'), '应检测到 <system-reminder>')
  assert(isSystemInjected('<system>\n# 系统指令'), '应检测到 <system>')
  assert(isSystemInjected('  <system-reminder>'), '应检测到空格前缀的 <system-reminder>')
  assert(!isSystemInjected('正常用户消息'), '正常消息不应被标记')
  assert(!isSystemInjected('<not-system>内容'), '非系统标签不应被标记')
  console.log(`✅ 全部通过`)
}

async function testFindInTaskDir() {
  console.log("=== 测试：task 子目录查找 ===\n")

  const sessionId = "task-agent-001"
  const taskDir = join(testDir, "task", "2026", "06", "05")
  await mkdir(taskDir, { recursive: true })

  const taskFile = join(taskDir, `1200-${sessionId}-Explore.md`)
  await appendFile(taskFile, "task content")
  console.log(`创建 task 文件: ${taskFile}`)

  // 应从 task 子目录中找到文件
  const found = await findExistingFile(testDir, sessionId)
  assert(found === taskFile, `应在 task 目录找到文件，实际: ${found}`)
  console.log(`✅ 测试通过：在 task 子目录中找到文件`)
}

async function main() {
  try {
    await setup()
    await testCrossDayMerge()
    await testCrossDayAppend()
    await testDifferentSession()
    await testSanitizeFilename()
    await testIsSystemInjected()
    await testFindInTaskDir()
    console.log("\n所有测试通过")
  } finally {
    await cleanup()
  }
}

main().catch(console.error)
