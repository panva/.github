import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { composeArgs, composeFile, overrideFile, run, suiteDir } from './common.js';

const suiteBaseUrl = 'https://localhost.emobix.co.uk:8443';
const version = getInput('version');

if (!version) {
  error('version is required');
  process.exit(1);
}

await setEnv('SUITE_BASE_URL', suiteBaseUrl);
await setEnv('IMAGE_TAG', version);
process.env.IMAGE_TAG = version;

await mkdir(suiteDir, { recursive: true });
await run('curl', [
  '-fsSLo',
  composeFile,
  `https://gitlab.com/openid/conformance-suite/-/raw/${version}/docker-compose-prebuilt.yml`,
]);
await writeFile(
  overrideFile,
  `services:
  nginx:
    networks:
      default:
        aliases:
          - localhost.emobix.co.uk
`,
);

await run('docker', [...composeArgs, 'up', '-d', '--pull', 'missing']);

for (let attempt = 1; attempt <= 10; attempt += 1) {
  const ready = await run(
    'curl',
    ['-skfail', `${suiteBaseUrl}/api/runner/available`],
    { reject: false, stdio: 'ignore' },
  );

  if (ready === 0) {
    process.exit(0);
  }

  await sleep(1000);
}

await run('docker', [...composeArgs, 'ps'], { reject: false });
await run('docker', [...composeArgs, 'logs', '--tail=300'], { reject: false });
process.exit(1);

function getInput(name) {
  return (process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] || '').trim();
}

function error(message) {
  console.error(`::error::${message}`);
}

async function setEnv(name, value) {
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `${name}=${value}\n`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
