/**
 * 사용법: npm run release
 * 새 버전 태그를 만들고 GitHub에 푸시하면 Actions가 자동으로 .exe를 빌드합니다.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import readline from 'readline';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const current = pkg.version;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`\n현재 버전: v${current}`);
console.log('새 버전을 입력하세요 (예: 1.0.1, 1.1.0, 2.0.0)\n');

rl.question('새 버전: ', (version) => {
  rl.close();

  const v = version.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    console.error('❌ 버전 형식이 올바르지 않습니다. (예: 1.0.1)');
    process.exit(1);
  }

  const tag = `v${v}`;

  // package.json 버전 업데이트
  pkg.version = v;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log(`\n✅ package.json 버전 → ${v}`);

  try {
    execSync('git add package.json', { stdio: 'inherit' });
    execSync(`git commit -m "chore: bump version to ${tag}"`, { stdio: 'inherit' });
    execSync(`git tag ${tag}`, { stdio: 'inherit' });
    execSync(`git push origin HEAD --tags`, { stdio: 'inherit' });
    console.log(`\n🚀 태그 ${tag} 푸시 완료!`);
    console.log('GitHub Actions가 Windows .exe 빌드를 시작합니다.');
    console.log('약 5~10분 후 Releases 페이지에서 다운로드 가능합니다.\n');
  } catch (e) {
    console.error('❌ Git 명령 실패:', e.message);
    process.exit(1);
  }
});
