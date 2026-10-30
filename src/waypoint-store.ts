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

/** "(x, y, z) in overworld"; without " in …" for a waypoint saved without a dimension. */
export function describeWaypointPlace(waypoint: Waypoint): string {
  return `(${waypoint.x}, ${waypoint.y}, ${waypoint.z})${waypoint.dimension ? ` in ${waypoint.dimension}` : ''}`;
}

/**
 * Why a waypoint found only under the host's own key cannot be used by name (E-041): it was saved before waypoints were
 * kept per world, so it may belong to any world on this host. `name` is the normalized name.
 */
export function legacyWaypointError(name: string, waypoint: Waypoint): string {
  return `Waypoint '${name}' was saved before waypoints were kept per world and may belong to another world: ${describeWaypointPlace(waypoint)}. ` +
    'If it is in this world, save it again with set-waypoint, then retry';
}

/**
 * Waypoints in one JSON file, keyed by namespace. The namespace is the server host, and once setWorld gives the world's
 * fingerprint, "<host>|seed:<hex>" (E-041): a LAN world is always localhost, so the host alone let every world on this
 * computer share one `home`. The entries under the bare host key from before that are the legacy waypoints; they are
 * read only through the legacy* methods and never moved.
 */
export class WaypointStore {
  private namespace: string;
  // The bare host key while a world fingerprint is set; null otherwise, when the host key is the namespace itself.
  private legacyNamespace: string | null = null;

  constructor(
    private filePath: string,
    private host: string
  ) {
    this.namespace = host;
  }

  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Keeps waypoints per world from now on (E-041): `fingerprint` is the connection's world fingerprint, null when the
   * server sent none, which keeps them per host as before. Called on every join, before the Autopilot binds.
   */
  setWorld(fingerprint: string | null): void {
    this.namespace = fingerprint ? `${this.host}|seed:${fingerprint}` : this.host;
    this.legacyNamespace = fingerprint ? this.host : null;
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
    return this.deleteFrom(this.namespace, name);
  }

  list(): Record<string, Waypoint> {
    return this.read()[this.namespace] ?? {};
  }

  /** The host's waypoints from before they were kept per world (E-041); empty while no world fingerprint is set. */
  legacyList(): Record<string, Waypoint> {
    return this.legacyNamespace === null ? {} : this.read()[this.legacyNamespace] ?? {};
  }

  legacyGet(name: string): Waypoint | undefined {
    return this.legacyNamespace === null ? undefined : this.read()[this.legacyNamespace]?.[this.normalizeName(name)];
  }

  /** Only delete-waypoint removes a legacy waypoint; nothing else changes them. */
  legacyDelete(name: string): boolean {
    return this.legacyNamespace === null ? false : this.deleteFrom(this.legacyNamespace, name);
  }

  private deleteFrom(namespace: string, name: string): boolean {
    const key = this.normalizeName(name);
    const data = this.read();
    if (!data[namespace]?.[key]) return false;

    delete data[namespace][key];
    this.write(data);
    return true;
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
