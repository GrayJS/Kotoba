import { statSync } from 'node:fs';
import path from 'node:path';

// Accept existing CTranslate2 models without requiring our download marker.
export function modelPrepared(directory: string): boolean {
  try {
    return ['config.json', 'model.bin', 'tokenizer.json'].every(file => {
      const stat = statSync(path.join(directory, file)); return stat.isFile() && stat.size > 0;
    }) && ['vocabulary.json', 'vocabulary.txt'].some(file => {
      try { const stat = statSync(path.join(directory, file)); return stat.isFile() && stat.size > 0; } catch { return false; }
    });
  } catch { return false; }
}
