import { existsSync } from 'node:fs';
import { composeArgs, composeFile, mongoDir, run } from './common.js';

if (existsSync(composeFile)) {
  await run('docker', [...composeArgs, 'down', '--volumes'], { reject: false });
}

await run('sudo', ['rm', '-rf', mongoDir], { reject: false });
