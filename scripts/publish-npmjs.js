#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

function runCommand(command, options = {}) {
  console.log(`\n> ${command}`);
  try {
    execSync(command, { stdio: 'inherit', cwd: rootDir, ...options });
    return true;
  } catch (error) {
    if (!options.allowFail) {
      console.error(`\n✕ 命令执行失败: ${command}`);
      process.exit(1);
    }
    return false;
  }
}

function checkNpmAuth() {
  console.log('\n检查 npm 登录状态...');
  const isLoggedIn = runCommand('npm whoami --registry https://registry.npmjs.org/', { allowFail: true });
  if (!isLoggedIn) {
    console.error('未登录 npm，请先配置 token');
    process.exit(1);
  }
  console.log('✅ npm 已登录');
}

function runTypecheck() {
  console.log('\n运行类型检查...');
  runCommand('npx tsc --noEmit');
  console.log('✅ 类型检查通过');
}

function runTests() {
  console.log('\n运行测试...');
  const hasTests = existsSync(join(rootDir, 'test'));
  if (!hasTests) {
    console.log('跳过测试（测试目录不存在）');
    return;
  }
  runCommand('npm test');
  console.log('✅ 测试通过');
}

function build() {
  console.log('\n构建项目...');
  runCommand('npm run build');
  console.log('✅ 构建完成');
}

function publish() {
  console.log('\n发布到 npmjs...');
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  console.log(`包名: ${pkg.name}`);
  console.log(`版本: ${pkg.version}`);
  runCommand('npm publish --registry https://registry.npmjs.org/ --ignore-scripts');
  console.log(`\n✅ 发布成功: ${pkg.name}@${pkg.version}`);
}

function gitCommitAndTag() {
  console.log('\nGit 提交并打 tag...');
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  const version = pkg.version;

  runCommand(`git add package.json`);
  const hasChanges = execSync('git diff --cached --name-only', { cwd: rootDir, encoding: 'utf-8' }).trim();
  if (hasChanges) {
    runCommand(`git commit -m "${version}"`);
  } else {
    console.log('无变更需要提交');
  }

  const tagName = `v${version}`;
  const tagExists = execSync(`git tag -l "${tagName}"`, { cwd: rootDir, encoding: 'utf-8' }).trim();
  if (!tagExists) {
    runCommand(`git tag "${tagName}"`);
  } else {
    console.log(`Tag ${tagName} 已存在，跳过`);
  }

  runCommand('git push origin main');
  runCommand(`git push origin "${tagName}"`);
  console.log(`✅ Git 已提交并推送: ${tagName}`);
}

function main() {
  console.log('🚀 开始发布流程\n');

  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  console.log(`版本: ${pkg.version}`);

  checkNpmAuth();
  runTypecheck();
  runTests();
  build();
  publish();
  gitCommitAndTag();

  console.log('\n🎉 发布流程全部完成！');
}

main();
