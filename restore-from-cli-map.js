#!/usr/bin/env node
/**
 * 从 @anthropic-ai/claude-code 的 dist/cli.js.map 还原 sourcesContent 到目录树。
 * 逻辑与 claude/README.md 中「解析 cli.js.map」一致。
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { map: null, out: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--map') args.map = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (!a.startsWith('-') && args.map === null) args.map = a;
    else if (!a.startsWith('-') && args.out === null) args.out = a;
    else {
      console.error(`未知参数: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function usage() {
  console.error(`用法: node restore-from-cli-map.js [选项] [map路径] [输出目录]

选项:
  --map <路径>   cli.js.map 文件（默认: claude-cli-js-map/cli.js.map）
  --out <目录>   还原输出根目录（默认: claude-code-source）
  -h, --help     显示本说明

示例:
  node src/restore-from-cli-map.js
  node src/restore-from-cli-map.js ./claude-cli-js-map/cli.js.map ./out-source
`);
}

function normalizeSourcePath(relPath) {
  let p = relPath;
  while (p.startsWith('../')) p = p.slice(3);
  return p;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const cwd = process.cwd();
  const mapPath = path.resolve(cwd, args.map ?? 'claude-cli-js-map/cli.js.map');
  const outDir = path.resolve(cwd, args.out ?? 'claude-code-source');

  if (!fs.existsSync(mapPath)) {
    console.error(`找不到 source map: ${mapPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(mapPath, 'utf8');
  const map = JSON.parse(raw);
  const { sources, sourcesContent } = map;
  if (!Array.isArray(sources) || !Array.isArray(sourcesContent)) {
    console.error('无效的 source map: 缺少 sources / sourcesContent 数组');
    process.exit(1);
  }

  let written = 0;
  let skipped = 0;
  for (let i = 0; i < sources.length; i++) {
    const content = sourcesContent[i];
    if (content == null || content === '') {
      skipped++;
      continue;
    }
    const relPath = normalizeSourcePath(sources[i]);
    const outPath = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
    written++;
  }

  console.error(`完成: 写入 ${written} 个文件, 跳过空项 ${skipped}, 输出目录: ${outDir}`);
}

main();
