/**
 * scripts/setup-source.ts
 * ---------------------------------------------------------------------------
 * 开发前置准备：让仓库保持轻量，数据用到时再拉。
 *
 * 目标状态：
 *   vendor/hanzi-glyphs-svg/glyphs/   原始字形仓库（约 230MB，gitignore）
 *   data/manifest.json                构建产物（约 55MB，gitignore）
 *
 * 原始仓库的获取按以下顺序尝试，命中即止：
 *   1. 项目根 / 上级目录里已有的 hanzi-glyphs-svg*.zip（手动下载的压缩包，最快）
 *   2. git clone --depth 1
 *   3. GitHub tarball（codeload 直连 + 两个加速镜像）
 *
 * 数据没构建过就自动跑一次全量构建；已存在则直接跳过，保证 `npm run dev` 秒开。
 *
 * 手动用法：
 *   npm run setup                  # 缺什么补什么
 *   npm run setup -- --force       # 强制重新拉取并重建
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VENDOR = path.join(ROOT, 'vendor', 'hanzi-glyphs-svg');
const DATA_MANIFEST = path.join(ROOT, 'data', 'manifest.json');

const REPO = 'zhouyongh/hanzi-glyphs-svg';
const BRANCH = 'main';
const REPO_URL = `https://github.com/${REPO}`;

/** tarball 下载镜像链，按顺序尝试。 */
const TARBALL_MIRRORS = [
  `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`,
  `https://gh-proxy.com/${REPO_URL}/archive/refs/heads/${BRANCH}.tar.gz`,
  `https://ghproxy.net/${REPO_URL}/archive/refs/heads/${BRANCH}.tar.gz`,
];

function log(message: string): void {
  console.log(`[setup] ${message}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 执行外部命令，返回退出码。 */
function run(command: string, args: string[], cwd = ROOT): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** 解压 zip：优先 bsdtar（Windows 10+ 自带），失败再试 unzip。 */
async function extractZip(zipPath: string, destDir: string): Promise<boolean> {
  await fs.mkdir(destDir, { recursive: true });

  const tarCode = await run('tar', [
    '-xf',
    zipPath,
    '-C',
    destDir,
    '--strip-components=1',
  ]);
  if (tarCode === 0) return true;

  const unzipCode = await run('unzip', ['-q', '-o', zipPath, '-d', destDir]);
  return unzipCode === 0;
}

/** 解压 tar.gz。 */
async function extractTarGz(tarPath: string, destDir: string): Promise<boolean> {
  await fs.mkdir(destDir, { recursive: true });
  const code = await run('tar', ['-xzf', tarPath, '-C', destDir, '--strip-components=1']);
  return code === 0;
}

/** 在项目根与上级目录里找手动下载的压缩包。 */
async function findLocalZip(): Promise<string | null> {
  const candidates = [
    ROOT,
    path.resolve(ROOT, '..'),
    path.join(ROOT, 'vendor'),
  ];

  for (const dir of candidates) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    const hit = entries.find(
      (name) => /^hanzi-glyphs-svg.*\.zip$/i.test(name),
    );
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** 流式下载到文件，避免把 200MB 全读进内存。 */
async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30 * 60 * 1000),
    headers: { 'user-agent': 'font-time-setup' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(dest));
  const stat = await fs.stat(dest);
  if (stat.size < 1024 * 1024) {
    throw new Error(`下载内容过小（${stat.size} 字节），可能不是有效压缩包`);
  }
}

/** 确保 vendor 目录里有完整仓库。 */
async function ensureVendor(force: boolean): Promise<void> {
  if (!force && (await exists(path.join(VENDOR, 'glyphs')))) {
    log(`原始仓库已就绪：${path.relative(ROOT, VENDOR)}`);
    return;
  }

  await fs.rm(VENDOR, { recursive: true, force: true });
  await fs.mkdir(path.dirname(VENDOR), { recursive: true });

  // 1) 本地压缩包
  const zip = await findLocalZip();
  if (zip) {
    log(`发现本地压缩包 ${path.relative(ROOT, zip)}，直接解压（比下载快得多）…`);
    if (await extractZip(zip, VENDOR)) {
      log('解压完成');
      return;
    }
    log('解压失败，改用网络获取');
    await fs.rm(VENDOR, { recursive: true, force: true });
  }

  // 2) git clone
  log('尝试 git clone（大仓库可能中断，失败会自动回退到 tarball）…');
  const cloneCode = await run('git', [
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--branch',
    BRANCH,
    REPO_URL,
    VENDOR,
  ]);
  if (cloneCode === 0 && (await exists(path.join(VENDOR, 'glyphs')))) {
    log('git clone 完成');
    return;
  }
  await fs.rm(VENDOR, { recursive: true, force: true });

  // 3) tarball 镜像
  const tmpTar = path.join(ROOT, 'vendor', '.source.tar.gz');
  for (const url of TARBALL_MIRRORS) {
    try {
      log(`下载 tarball：${new URL(url).host}（约 230MB，请耐心等待）…`);
      await download(url, tmpTar);
      log('下载完成，解压中…');
      if (await extractTarGz(tmpTar, VENDOR)) {
        await fs.rm(tmpTar, { force: true });
        log('解压完成');
        return;
      }
    } catch (error) {
      log(`镜像失败：${(error as Error).message}`);
    }
    await fs.rm(tmpTar, { force: true });
    await fs.rm(VENDOR, { recursive: true, force: true });
  }

  throw new Error(
    '无法获取原始字形仓库。请手动下载后放到项目根目录：\n' +
      `  ${REPO_URL}\n` +
      '  绿色 Code 按钮 → Download ZIP，放到 font-time/ 下即可，再执行 npm run setup',
  );
}

/** 确保 data/ 里有构建产物。 */
async function ensureData(force: boolean): Promise<void> {
  if (!force && (await exists(DATA_MANIFEST))) {
    log('字形数据已构建，跳过（需要重建请执行 npm run data:build -- --all --local=vendor/hanzi-glyphs-svg）');
    return;
  }

  log('开始构建全量字形数据…');
  const code = await run('npx', [
    'tsx',
    'scripts/build-glyphs.ts',
    '--all',
    `--local=${VENDOR}`,
  ]);
  if (code !== 0) {
    throw new Error('字形数据构建失败，请检查上面的日志');
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  try {
    await ensureVendor(force);
    await ensureData(force);
    log('准备完成，可以开始开发了');
  } catch (error) {
    // 不阻断 dev：前端会自动回落到 public/data/glyphs.json（20 字小字集）
    console.warn(`\n[setup] ${(error as Error).message}\n`);
    console.warn('[setup] 已跳过，开发服务器仍会启动，但只有内置小字集可用。\n');
  }
}

main();
