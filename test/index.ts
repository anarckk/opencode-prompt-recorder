import { mkdir, rm, appendFile, readdir } from "fs/promises"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const testDir = join(__dirname, "test-prompts-temp", ".agent", "prompts")

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

async function setup() {
  await mkdir(join(testDir, "2026", "02", "24"), { recursive: true })
  await mkdir(join(testDir, "2026", "02", "25"), { recursive: true })
}

async function cleanup() {
  await rm(testDir, { recursive: true, force: true })
}

async function findExistingFile(promptsBaseDir: string, sessionId: string): Promise<string | null> {
  if (!sessionId) return null

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

async function testCrossDayMerge() {
  console.log("=== 测试：跨天会话合并 ===\n")
  
  const sessionId = "test-session-001"
  const topic = "测试主题"
  
  // 第一天 23:50 创建文件
  const day1File = join(testDir, "2026", "02", "24", `2350-${sessionId}-${topic}.md`)
  await appendFile(day1File, "============ 23:50 ============\n\n第一天23点50分的提示词")
  console.log(`创建文件: ${day1File}`)
  
  // 第二天 0:03 应该追加到同一文件
  const existingFile = await findExistingFile(testDir, sessionId)
  assert(existingFile === day1File, `应找到文件 ${day1File}，实际: ${existingFile}`)
  console.log(`✅ 测试通过：找到跨天文件`)
  
  // 验证内容
  const { readFile } = await import("fs/promises")
  const content = await readFile(existingFile!, "utf-8")
  assert(content.includes("第一天23点50分"), "文件应包含Day1内容")
  console.log(`✅ 测试通过：文件内容正确`)
}

async function testCrossDayAppend() {
  console.log("=== 测试：跨天追加内容 ===\n")
  
  const sessionId = "test-session-002"
  const topic = "跨天主题"
  
  // 第一天创建文件
  const day1File = join(testDir, "2026", "02", "24", `2350-${sessionId}-${topic}.md`)
  await appendFile(day1File, "============ 23:50 ============\n\n第一天23点50分的提示词")
  console.log(`Day1 创建文件: ${day1File}`)
  
  // 模拟次日（不创建文件，只测试查找和追加逻辑）
  const existingFile = await findExistingFile(testDir, sessionId)
  assert(existingFile === day1File, `应找到文件 ${day1File}`)
  console.log(`✅ 测试通过：Day2 找到跨天文件`)
  
  // 模拟追加内容
  const appendContent = `\n\n============ 00:03 ============\n\n第二天0点3分的提示词`
  await appendFile(existingFile!, appendContent)
  
  // 验证最终内容
  const { readFile } = await import("fs/promises")
  const finalContent = await readFile(existingFile!, "utf-8")
  
  // 验证是否包含两天的内容
  assert(finalContent.includes("第一天23点50分"), "应包含Day1内容")
  assert(finalContent.includes("第二天0点3分"), "应包含Day2内容")
  console.log(`✅ 测试通过：跨天追加内容正确`)
}

async function testDifferentSession() {
  console.log("=== 测试：不同会话ID创建新文件 ===\n")
  
  // 先创建一个文件
  const session1 = "session-001"
  const file1 = join(testDir, "2026", "02", "24", `1200-${session1}-主题A.md`)
  await mkdir(join(testDir, "2026", "02", "24"), { recursive: true })
  await appendFile(file1, "内容1")
  
  // 查找不存在的 session
  const result = await findExistingFile(testDir, "session-999")
  assert(result === null, `应返回 null，实际: ${result}`)
  console.log(`✅ 测试通过：不存在的session返回null`)
}

async function main() {
  try {
    await setup()
    await testCrossDayMerge()
    await testCrossDayAppend()
    await testDifferentSession()
    console.log("测试完成")
  } finally {
    await cleanup()
  }
}

main().catch(console.error)
