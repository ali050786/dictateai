import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, writePrivateFile } from './config';
import { CleanupLocation } from './llm-formatter';

// Recent dictations, kept on disk (owner-only) so they survive a restart.

const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const MAX_ENTRIES = 100;

export interface HistoryEntry {
  text: string;
  app: string;
  time: string;
  location: CleanupLocation;
}

let entries: HistoryEntry[] | null = null;

function load(): HistoryEntry[] {
  if (entries) return entries;
  try {
    entries = fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8')) : [];
  } catch {
    entries = [];
  }
  return entries!;
}

function save(): void {
  writePrivateFile(HISTORY_PATH, JSON.stringify(load(), null, 2));
}

export function addHistory(entry: HistoryEntry): void {
  const list = load();
  list.unshift(entry);
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  save();
}

export function listHistory(): HistoryEntry[] {
  return load();
}

export function clearHistory(): void {
  entries = [];
  save();
}
