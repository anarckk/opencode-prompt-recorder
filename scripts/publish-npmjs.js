#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, rmSync, writeFileSync } from 'fs';
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

function build() {
  console.log('\n构建项目...');

  rmSync(join(rootDir, 'dist'), { recursive: true, force: true });

  const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
  runCommand(
    'npx esbuild index.ts --bundle --platform=node --outdir=dist --format=esm --external:@opencode-ai/plugin --minify',
    { shell }
  );

  const pkg = readFileSync(join(rootDir, 'package.json'), 'utf-8');
  writeFileSync(join(rootDir, 'dist', 'package.json'), pkg);

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

function main() {
  console.log('🚀 开始发布流程\n');

  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  console.log(`版本: ${pkg.version}`);

  checkNpmAuth();
  runTypecheck();
  build();
  publish();

  console.log('\n🎉 发布流程全部完成！');
}

main();
