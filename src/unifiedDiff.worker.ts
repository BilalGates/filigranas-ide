import { unifiedDiff } from './unifiedDiff';
import type { DiffTexts } from './ipc';

self.onmessage = ({ data }: MessageEvent<{ id: number; texts: DiffTexts }>) => {
  const { id, texts } = data;
  try {
    self.postMessage({ id, result: unifiedDiff(texts.old, texts.new) });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
