import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// The speech and cleanup engines ship inside the app (scripts/build-engines.sh
// puts them in engines/; forge copies them to Contents/Resources), so users
// install nothing else.
// In dev: __dirname = <project>/.webpack/main → go up 2 to reach project root.
export function enginesDir(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.join(path.resolve(__dirname, '..', '..'), 'engines');
}

export function bundledPath(...parts: string[]): string | null {
  const p = path.join(enginesDir(), ...parts);
  return fs.existsSync(p) ? p : null;
}

// Bytes in a folder, without following symlinks (the Hugging Face cache links
// each file to a blob, which would otherwise be counted twice).
export function folderBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderBytes(p);
    else if (entry.isFile()) {
      try { total += fs.statSync(p).size; } catch {}
    }
  }
  return total;
}

// The engines download models themselves and report no progress, so watch the
// folder they download into grow. Percent is null until a download is seen.
export class DownloadWatch {
  private start = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  percent: number | null = null;

  constructor(private dir: string, private expectedBytes: number, private onChange: () => void) {}

  begin(): void {
    this.end();
    this.start = folderBytes(this.dir);
    this.percent = null;
    this.timer = setInterval(() => {
      const grown = folderBytes(this.dir) - this.start;
      // A few MB is config and tokenizer files, not the model download.
      const next = grown > 5_000_000 ? Math.min(99, Math.floor((grown / this.expectedBytes) * 100)) : null;
      if (next !== this.percent) {
        this.percent = next;
        this.onChange();
      }
    }, 1000);
  }

  end(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.percent = null;
  }
}

export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
