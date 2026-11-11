// Entry point of the main thread, built to dist/code.js (the manifest's `main`).
import { startPlugin } from './plugin.ts';

startPlugin(figma, __html__);
