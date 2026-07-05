/**
 * data/JsonFeedReader.ts — JSON data feed parsing and scope binding.
 *
 * Supports four JSON feed shapes:
 *   Flat array:      [{"A":"1","B":"2"}, ...]
 *   Structured:      {"data":[{"A":"1","B":"2"}, ...]}  (first array-valued key auto-detected)
 *   Nested object:   {"addr":{"city":"NYC"}} → col "addr.city" = "NYC"
 *   Nested array:    {"tags":["x","y"]} → col "tags" = "x\ny"
 *
 * Settings respected (same pattern as CsvFeedReader):
 *   dataKey option   → explicit key to extract the records array from an object
 *   prefix option    → prepend prefix to all column names when binding to scope
 */

import * as fs from 'fs';
import type { Scope } from '../engine/Scope';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single flattened record from a JSON feed — column name → string value. */
export type JsonDataRecord = Record<string, string>;

export interface JsonFeedOptions {
  /**
   * Explicit key to extract the records array from a top-level object.
   * If omitted, the first key whose value is an array is used.
   */
  dataKey?: string;
  /**
   * Column name prefix applied to all fields when flattening.
   * e.g. prefix='user' turns {"name":"Bob"} → {"user.name":"Bob"}
   */
  prefix?: string;
  /**
   * When true, string values are trimmed of leading/trailing whitespace.
   * Matches pgwen.auto.trim.data.json behaviour. Default: false.
   */
  autoTrim?: boolean;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Read a JSON file from disk and parse it into flattened records.
 */
export function parseJsonFeed(filePath: string, options: JsonFeedOptions = {}): JsonDataRecord[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseJsonContent(content, options);
}

/**
 * Parse JSON content string into flattened records.
 * Useful for testing without disk I/O.
 */
export function parseJsonContent(content: string, options: JsonFeedOptions = {}): JsonDataRecord[] {
  const json: unknown = JSON.parse(content);
  const rawRecords = extractRecords(json, options.dataKey);
  return rawRecords.map((rec) => flattenRecord(rec, options.prefix, options.autoTrim));
}

// ─── Record extraction ────────────────────────────────────────────────────────

/**
 * Extract an array of raw objects from a parsed JSON value.
 *
 * Rules:
 *   - Top-level array  → use directly (filter to objects only)
 *   - Top-level object with dataKey → use obj[dataKey] array
 *   - Top-level object (auto)       → use first array-valued key
 *   - Single top-level object       → treat as one record
 */
function extractRecords(json: unknown, dataKey?: string): Record<string, unknown>[] {
  if (Array.isArray(json)) {
    // If all elements are non-objects (primitives), bind each value to key "data"
    if (json.length > 0 && !isObject(json[0])) {
      return json.map((v) => ({ data: String(v ?? '') }));
    }
    return json.filter(isObject);
  }

  if (isObject(json)) {
    const obj = json as Record<string, unknown>;

    if (dataKey !== undefined) {
      const val = obj[dataKey];
      return Array.isArray(val) ? val.filter(isObject) : [];
    }

    // Auto-detect: first key whose value is an array
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (Array.isArray(val)) {
        return val.filter(isObject);
      }
    }

    // Single object — treat as one record
    return [obj];
  }

  return [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Flattening ───────────────────────────────────────────────────────────────

/**
 * Flatten a nested record into a flat Record<string, string>.
 * Nested objects use dot-notation keys: {"addr":{"city":"NYC"}} → {"addr.city":"NYC"}
 * Nested arrays join primitive values with newline; objects are JSON-stringified.
 */
function flattenRecord(obj: Record<string, unknown>, prefix?: string, autoTrim = false): JsonDataRecord {
  const result: JsonDataRecord = {};
  flattenInto(obj, prefix ?? '', result, autoTrim);
  return result;
}

function flattenInto(
  obj: Record<string, unknown>,
  prefix: string,
  result: JsonDataRecord,
  autoTrim: boolean
): void {
  for (const [key, value] of Object.entries(obj)) {
    const colName = prefix ? `${prefix}.${key}` : key;

    if (value === null || value === undefined) {
      result[colName] = '';
    } else if (isObject(value)) {
      flattenInto(value as Record<string, unknown>, colName, result, autoTrim);
    } else if (Array.isArray(value)) {
      const str = value
        .map((v) => (isObject(v) ? JSON.stringify(v) : String(v ?? '')))
        .join('\n');
      result[colName] = autoTrim ? str.trim() : str;
    } else {
      const str = String(value);
      result[colName] = autoTrim ? str.trim() : str;
    }
  }
}

// ─── Scope binding ────────────────────────────────────────────────────────────

/**
 * Bind all columns of a JSON data record into the given scope.
 * Also sets the implicit pgwen.data.record.* values.
 *
 * Call once per record before executing the feature/scenario for that record.
 *
 * @param readOnly When true, column bindings are locked as read-only. Mirrors
 *   the reference framework's pgwen.input.data.readOnly=true default.
 */
export function bindJsonRecordToScope(
  record: JsonDataRecord,
  recordIndex: number,
  scope: Scope,
  readOnly = false
): void {
  for (const [column, value] of Object.entries(record)) {
    if (readOnly) {
      scope.setReadonly(column, value);
    } else {
      scope.set(column, value);
    }
  }
  scope.set('pgwen.data.record.index', String(recordIndex));
  scope.set('pgwen.data.record.number', String(recordIndex + 1));
}

/**
 * Returns the column headers (keys) from the first record, or empty array if feed is empty.
 */
export function getJsonFeedHeaders(records: JsonDataRecord[]): string[] {
  if (records.length === 0) return [];
  return Object.keys(records[0]!);
}
