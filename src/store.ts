import { ResponseStateStore, StoredResponseRecord } from "./types";

export class MemoryResponseStateStore implements ResponseStateStore {
  private readonly records = new Map<string, StoredResponseRecord>();

  get(id: string): StoredResponseRecord | undefined {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    if (record.expiresAt <= Date.now()) {
      this.records.delete(id);
      return undefined;
    }
    return record;
  }

  set(record: StoredResponseRecord): void {
    this.records.set(record.id, record);
  }

  delete(id: string): void {
    this.records.delete(id);
  }

  gc(now: number = Date.now()): void {
    for (const [id, record] of this.records.entries()) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
      }
    }
  }
}
