import { fileURLToPath } from 'node:url';

export const DB_PATH = process.env.DB_PATH ?? fileURLToPath(new URL('../data/app.db', import.meta.url));
export const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));
export const PORT = Number(process.env.PORT ?? 3001);
/** Compresses engine timing for load tests, e.g. 0.05 turns 20s into 1s. */
export const TIME_SCALE = Number(process.env.ROUTING_TIME_SCALE ?? 1);
