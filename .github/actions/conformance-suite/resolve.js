import { appendFile } from 'node:fs/promises';

const suiteBaseUrl = 'https://localhost.emobix.co.uk:8443';
const versionOverride = (process.env.VERSION_OVERRIDE || '').trim();
const latest = await getLatestReleaseTag({ required: !versionOverride });
const version = versionOverride || latest;

await setEnv('SUITE_BASE_URL', suiteBaseUrl);
await setEnv('IMAGE_TAG', version);
await setOutput('version', version);
logDetails({ latest, version, versionOverride });

function error(message) {
  console.error(`::error::${message}`);
}

async function getLatestReleaseTag({ required }) {
  try {
    const response = await fetch('https://gitlab.com/api/v4/projects/4175605/releases');

    if (!response.ok) {
      throw new Error(`GitLab release API responded with ${response.status}`);
    }

    const releases = await response.json();
    const tagName = Array.isArray(releases) ? releases[0]?.tag_name : undefined;

    if (tagName) {
      return tagName;
    }
  } catch (err) {
    if (required) {
      error(`Could not resolve the latest Conformance Suite release: ${err.message}`);
      process.exit(1);
    }
  }

  if (required) {
    error('Could not resolve the latest Conformance Suite release');
    process.exit(1);
  }

  return '';
}

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

async function setEnv(name, value) {
  if (process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `${name}=${value}\n`);
  }
}

function logDetails({ latest, version, versionOverride }) {
  console.log('Conformance Suite Details');
  if (versionOverride) {
    console.log(`Version: ${version} (override)`);

    if (latest && latest !== version) {
      console.log(`Latest Available: ${latest}`);
    }
  } else {
    console.log(`Version: ${version}`);
  }

  console.log(`Compose: docker-compose-prebuilt.yml@${version}`);
}
