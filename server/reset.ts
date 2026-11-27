/** Deletes all local data. Stop the server first. */
import { rmSync } from 'node:fs';
import { DB_PATH } from './config.ts';

for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
console.log('Local data removed.');
