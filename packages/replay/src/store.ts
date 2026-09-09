import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  applyTenantOverride,
  capability as capabilitySchema,
  type Capability,
  type CapabilityQuery,
  type CapabilityStore,
  type ResolvedCapability,
} from '@cua/contracts';

/**
 * =============================================================================
 * THE FILE-BACKED CAPABILITY STORE
 * =============================================================================
 * One directory of `*.capability.json`, one file per capability.
 *
 * The obvious objection is that the `CapabilityStore` contract talks about
 * versions and this keeps a single file per id. That is the point: **git is the
 * version history**. The artifact is a reviewable document, changing one is
 * exactly the kind of change that should arrive as a pull request, and a scheme
 * that appends `@1.0.1` to a filename turns every edit into a new file with no
 * diff against the thing it replaced — which is the one property review needs.
 *
 * So a query for a specific version is satisfied only if the file on disk *is*
 * that version, and a query for `null` takes what is checked in. A deployment
 * that needs several versions live at once replaces this class; nothing above it
 * changes, which is what the interface is for.
 *
 * Indexing is by parsed content rather than by filename, so a capability whose
 * file was renamed still resolves by id.
 */

/** Replay counts live beside the artifacts, not inside them — see `recordReplayOutcome`. */
export const STABILITY_FILE = '.stability.json';

interface StabilityCounts {
  [key: string]: { runs: number; succeeded: number };
}

export class FileCapabilityStore implements CapabilityStore {
  readonly #dir: string;

  constructor(dir = 'capabilities') {
    this.#dir = dir;
  }

  async get(query: CapabilityQuery): Promise<Capability | null> {
    for (const found of await this.#all()) {
      if (found.id !== query.id) continue;
      if (query.version !== null && found.version !== query.version) continue;
      if (query.requireApproved && found.approval.state !== 'approved') continue;
      return found;
    }
    return null;
  }

  async resolve(query: CapabilityQuery): Promise<ResolvedCapability | null> {
    const baseline = await this.get(query);
    return baseline === null ? null : applyTenantOverride(baseline, query.tenant);
  }

  async list(filter: { app?: string; approvedOnly?: boolean } = {}): Promise<readonly Capability[]> {
    return (await this.#all()).filter(
      (c) =>
        (filter.app === undefined || c.surface.app === filter.app) &&
        (filter.approvedOnly !== true || c.approval.state === 'approved'),
    );
  }

  async save(c: Capability): Promise<void> {
    const parsed = capabilitySchema.parse(c);
    await writeFile(
      join(this.#dir, `${parsed.id}.capability.json`),
      JSON.stringify(parsed, null, 2) + '\n',
      'utf8',
    );
  }

  /**
   * Accumulate the stability figure that feeds an approval decision.
   *
   * Kept in a sidecar rather than in `approval.observedStability`, because
   * writing to the artifact on every replay would put a machine-generated
   * counter into the file humans review and diff — every production run would
   * show up as a change to the capability. The artifact records what a person
   * decided; this file records what the runs did.
   */
  async recordReplayOutcome(id: string, version: string, succeeded: boolean): Promise<void> {
    const path = join(this.#dir, STABILITY_FILE);
    const counts = await this.#stability();
    const key = `${id}@${version}`;
    const prior = counts[key] ?? { runs: 0, succeeded: 0 };
    counts[key] = {
      runs: prior.runs + 1,
      succeeded: prior.succeeded + (succeeded ? 1 : 0),
    };
    await writeFile(path, JSON.stringify(counts, null, 2) + '\n', 'utf8');
  }

  /** Successful replays ÷ total replays, or null when nothing has run yet. */
  async stabilityOf(id: string, version: string): Promise<number | null> {
    const entry = (await this.#stability())[`${id}@${version}`];
    return entry === undefined || entry.runs === 0 ? null : entry.succeeded / entry.runs;
  }

  async #stability(): Promise<StabilityCounts> {
    try {
      return JSON.parse(await readFile(join(this.#dir, STABILITY_FILE), 'utf8')) as StabilityCounts;
    } catch {
      return {};
    }
  }

  async #all(): Promise<readonly Capability[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }

    const found: Capability[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.capability.json')) continue;
      const raw = await readFile(join(this.#dir, name), 'utf8');
      // Parsed, not cast. An artifact that no longer satisfies the schema must
      // fail here rather than three steps into a run against a real member.
      found.push(capabilitySchema.parse(JSON.parse(raw)));
    }
    return found;
  }
}
