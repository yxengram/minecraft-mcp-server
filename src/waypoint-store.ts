import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  dimension?: string;
  note?: string;
  createdAt: number;
}

type WaypointFile = Record<string, Record<string, Waypoint>>;

export function defaultWaypointFile(): string {
  return path.join(os.homedir(), '.minecraft-mcp-server', 'waypoints.json');
}

export class WaypointStore {
  constructor(
    private filePath: string,
    private namespace: string
  ) {}

  getFilePath(): string {
    return this.filePath;
  }

  normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }

  set(name: string, waypoint: Waypoint): void {
    const key = this.normalizeName(name);
    if (!key) throw new Error('Waypoint name cannot be empty');

    const data = this.read();
    data[this.namespace] = { ...data[this.namespace], [key]: waypoint };
    this.write(data);
  }

  get(name: string): Waypoint | undefined {
    return this.read()[this.namespace]?.[this.normalizeName(name)];
  }

  delete(name: string): boolean {
    const key = this.normalizeName(name);
    const data = this.read();
    if (!data[this.namespace]?.[key]) return false;

    delete data[this.namespace][key];
    this.write(data);
    return true;
  }

  list(): Record<string, Waypoint> {
    return this.read()[this.namespace] ?? {};
  }

  private read(): WaypointFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return {};
      throw error;
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('unexpected structure');
      }
      return parsed as WaypointFile;
    } catch {
      throw new Error(`Waypoint file ${this.filePath} is corrupted. Fix or delete it to continue`);
    }
  }

  private write(data: WaypointFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, this.filePath);
  }
}
