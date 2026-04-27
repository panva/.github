import { existsSync } from 'node:fs';
import { composeArgs, composeFile, mongoDir, overrideFile, run } from './common.js';

if (existsSync(composeFile) && existsSync(overrideFile)) {
  await run('docker', [...composeArgs, 'down', '--volumes'], { reject: false });
} else if (existsSync(composeFile)) {
  await run('docker', ['compose', '-f', composeFile, 'down', '--volumes'], {
    reject: false,
  });
}

await run('sudo', ['rm', '-rf', mongoDir], { reject: false });
