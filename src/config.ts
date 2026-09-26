import 'dotenv/config';
import path from 'path';
import { isIP } from 'net';

/**
 * The environment shape accepted by the parser.  Keeping this separate from
 * NodeJS.ProcessEnv makes it possible to exercise configuration without
 * mutating the process environment.
 */
export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export interface ConfigParseOptions {
  /** Base directory used to resolve a relative DATA_DIR. */
  cwd?: string;
  /** Disable the required-token/client checks when false (default: true). */
  strict?: boolean;
  /** Override the required-token check independently. */
  requireDiscordToken?: boolean;
  /** Override the required-client check independently. */
  requireClientId?: boolean;
}

export interface AppConfig {
  /** Discord credentials.  Never include these values in validation errors. */
  token: string;
  clientId: string;
  guildId: string;

  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  dashboardTrustProxy: boolean;
  dashboardPublic: boolean;
  dashboardOrigin: string | null;

  /** Effective allowlist. An empty list means no explicit guild restriction. */
  allowedGuildIds: string[];

  /** Absolute path used for persistent runtime state. */
  dataDir: string;

  /** Commerce is intentionally secret-free in this configuration object. */
  commerceFulfillmentEnabled: boolean;
  commerceAllowedProductIds: string[];
  commerceSharedSecretPresent: boolean;
}

export type Config = AppConfig;

export interface ConfigValidationResult {
  ok: boolean;
  /** Safe, value-free descriptions of validation failures. */
  errors: readonly string[];
  /** A complete normalized object, even when errors were found. */
  config: AppConfig;
}

export class ConfigValidationError extends Error {
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super(`Invalid configuration: ${errors.join('; ')}`);
    this.name = 'ConfigValidationError';
    this.errors = Object.freeze([...errors]);
  }
}

function defaultCwd(): string {
  return process.cwd();
}

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 3001;
export const DEFAULT_DATA_DIR_NAME = 'data';
export const DEFAULT_DATA_DIR = path.resolve(defaultCwd(), DEFAULT_DATA_DIR_NAME);

const DISCORD_ID_PATTERN = /^\d{1,20}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const PRODUCT_ID_MAX_LENGTH = 256;

type ParseState = {
  errors: string[];
};

type AliasRead = {
  present: boolean;
  value?: string;
};

function currentEnvironment(): ConfigEnvironment {
  // Keep the process environment behind this single boundary.
  return process.env;
}

function addError(state: ParseState, message: string): void {
  state.errors.push(message);
}

function environmentValue(env: ConfigEnvironment, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}

/**
 * Read the first configured alias without ever putting its value in an error.
 * Conflicting aliases fail closed rather than making security-sensitive
 * behavior depend on key order.
 */
function readAlias(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
  emptyIsError = true,
): AliasRead {
  const values: string[] = [];
  let present = false;

  for (const key of keys) {
    const raw = environmentValue(env, key);
    if (raw === undefined) continue;
    present = true;
    if (typeof raw !== 'string') {
      addError(state, `${label} must be a string`);
      continue;
    }
    const value = raw.trim();
    if (!value) {
      if (emptyIsError) addError(state, `${label} must not be empty`);
      continue;
    }
    values.push(value);
  }

  if (!present) return { present: false };
  if (new Set(values).size > 1) {
    addError(state, `${label} has conflicting values`);
  }
  return { present: true, value: values[0] };
}

function readString(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
  required: boolean,
): string {
  const read = readAlias(state, env, keys, label, required);
  if (!read.present) {
    if (required) addError(state, `${label} is required`);
    return '';
  }
  if (read.value === undefined) return '';
  if (CONTROL_CHARACTER_PATTERN.test(read.value) || /\s/.test(read.value)) {
    addError(state, `${label} must not contain whitespace or control characters`);
    return '';
  }
  return read.value;
}

function parseBoolean(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
  fallback: boolean,
): boolean {
  const read = readAlias(state, env, keys, label);
  if (!read.present || read.value === undefined) return fallback;
  const value = read.value.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  addError(state, `${label} must be either true or false`);
  return fallback;
}

function parsePort(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
  fallback: number,
): number {
  const read = readAlias(state, env, keys, label);
  if (!read.present) return fallback;
  if (read.value === undefined) return fallback;
  if (!/^\d{1,5}$/.test(read.value)) {
    addError(state, `${label} must be an integer from 1 to 65535`);
    return fallback;
  }
  const port = Number(read.value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    addError(state, `${label} must be an integer from 1 to 65535`);
    return fallback;
  }
  return port;
}

function isValidHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (CONTROL_CHARACTER_PATTERN.test(host) || /\s/.test(host)) return false;
  if (host.includes('/') || host.includes('\\') || host.includes(':') && isIP(host) === 0) {
    return false;
  }
  if (isIP(host) !== 0) return true;
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  return host.split('.').every((label) => SAFE_HOST_LABEL_PATTERN.test(label));
}

function parseHost(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
  fallback: string,
): string {
  const read = readAlias(state, env, keys, label);
  if (!read.present) return fallback;
  if (read.value === undefined) return fallback;
  if (!isValidHost(read.value)) {
    addError(state, `${label} must be a valid host name or IP address`);
    return fallback;
  }
  return read.value;
}

function parseOrigin(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
): string | null {
  const read = readAlias(state, env, keys, label, false);
  if (!read.present) return null;
  if (read.value === undefined) return null;

  let parsed: URL;
  try {
    parsed = new URL(read.value);
  } catch {
    addError(state, `${label} must be an absolute http(s) origin`);
    return null;
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    addError(state, `${label} must be an absolute origin without a path, query, fragment, or credentials`);
    return null;
  }
  return parsed.origin;
}

function parseDiscordId(
  state: ParseState,
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!DISCORD_ID_PATTERN.test(value) || /^0+$/.test(value)) {
    addError(state, `${label} must be a decimal Discord snowflake`);
    return undefined;
  }
  return value;
}

function splitList(
  state: ParseState,
  value: string,
  label: string,
): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    addError(state, `${label} must not be empty`);
    return [];
  }

  // Comma-separated values are the documented form.  Whitespace is also
  // accepted as a separator so a hand-edited .env remains usable.
  const commaParts = trimmed.split(',');
  const malformed = commaParts.some((part) => part.trim() === '');
  const values = trimmed
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (malformed) addError(state, `${label} contains an empty list item`);
  if (values.length === 0) {
    addError(state, `${label} must not be empty`);
    return [];
  }
  return values;
}

function parseDiscordIdList(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
): { present: boolean; values: string[] } {
  const read = readAlias(state, env, keys, label, false);
  if (!read.present) return { present: false, values: [] };
  if (read.value === undefined) return { present: false, values: [] };
  const values = splitList(state, read.value, label);
  const valid: string[] = [];
  for (const value of values) {
    const parsed = parseDiscordId(state, value, label);
    if (parsed !== undefined) valid.push(parsed);
  }
  return { present: true, values: [...new Set(valid)] };
}

function parseProductIdList(
  state: ParseState,
  env: ConfigEnvironment,
  keys: readonly string[],
  label: string,
): string[] {
  const read = readAlias(state, env, keys, label, false);
  if (!read.present) return [];
  if (read.value === undefined) return [];
  const values = splitList(state, read.value, label);
  const valid: string[] = [];
  for (const value of values) {
    if (
      value.length > PRODUCT_ID_MAX_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(value) ||
      /\s/.test(value)
    ) {
      addError(state, `${label} must contain only non-empty opaque product identifiers`);
      continue;
    }
    valid.push(value);
  }
  return [...new Set(valid)];
}

function parseDataDir(
  state: ParseState,
  env: ConfigEnvironment,
  cwd: string,
): string {
  const read = readAlias(state, env, ['DATA_DIR'], 'DATA_DIR', false);
  if (!read.present) return path.resolve(cwd, DEFAULT_DATA_DIR_NAME);
  if (read.value === undefined) return path.resolve(cwd, DEFAULT_DATA_DIR_NAME);
  if (read.value.includes('\0')) {
    addError(state, 'DATA_DIR must be a valid filesystem path');
    return path.resolve(cwd, DEFAULT_DATA_DIR_NAME);
  }
  return path.resolve(cwd, read.value);
}

function normalizeOptions(options?: ConfigParseOptions): Required<Pick<ConfigParseOptions, 'cwd' | 'strict' | 'requireDiscordToken' | 'requireClientId'>> {
  const value = options ?? {};
  const strict = value.strict ?? true;
  return {
    cwd: value.cwd ?? path.dirname(DEFAULT_DATA_DIR),
    strict,
    requireDiscordToken: value.requireDiscordToken ?? strict,
    requireClientId: value.requireClientId ?? strict,
  };
}

/**
 * Parse and validate a synthetic or real environment without mutating it.
 * The returned config is a safe normalized snapshot; secrets are represented
 * only by the required Discord token field and commerce presence booleans.
 */
export function validateConfig(
  env: ConfigEnvironment = currentEnvironment(),
  options: ConfigParseOptions = {},
): ConfigValidationResult {
  const state: ParseState = { errors: [] };
  const settings = normalizeOptions(options);
  const source: ConfigEnvironment = env && typeof env === 'object' ? env : {};

  const token = readString(state, source, ['DISCORD_TOKEN'], 'DISCORD_TOKEN', settings.requireDiscordToken);
  const clientIdValue = readString(state, source, ['CLIENT_ID'], 'CLIENT_ID', settings.requireClientId);
  const clientId = parseDiscordId(state, clientIdValue || undefined, 'CLIENT_ID') ?? '';
  const guildIdValue = readString(state, source, ['GUILD_ID'], 'GUILD_ID', false);
  const guildId = parseDiscordId(state, guildIdValue || undefined, 'GUILD_ID') ?? '';

  const dashboardEnabled = parseBoolean(
    state,
    source,
    ['DASHBOARD_ENABLED'],
    'DASHBOARD_ENABLED',
    true,
  );
  const dashboardHost = parseHost(
    state,
    source,
    ['DASHBOARD_HOST', 'DASHBOARD_BIND_HOST'],
    'DASHBOARD_HOST',
    DEFAULT_DASHBOARD_HOST,
  );
  const dashboardPort = parsePort(
    state,
    source,
    ['DASHBOARD_PORT'],
    'DASHBOARD_PORT',
    DEFAULT_DASHBOARD_PORT,
  );
  const dashboardTrustProxy = parseBoolean(
    state,
    source,
    ['DASHBOARD_TRUST_PROXY', 'DASHBOARD_TRUSTED_PROXY'],
    'DASHBOARD_TRUST_PROXY',
    false,
  );
  const dashboardPublic = parseBoolean(
    state,
    source,
    ['DASHBOARD_PUBLIC'],
    'DASHBOARD_PUBLIC',
    false,
  );
  const dashboardOrigin = parseOrigin(
    state,
    source,
    ['DASHBOARD_PUBLIC_ORIGIN', 'DASHBOARD_ORIGIN', 'DASHBOARD_PUBLIC_URL'],
    'DASHBOARD_PUBLIC_ORIGIN',
  );

  const allowedGuildRead = parseDiscordIdList(
    state,
    source,
    ['ALLOWED_GUILD_IDS', 'GUILD_ALLOWLIST', 'ALLOWED_GUILDS'],
    'ALLOWED_GUILD_IDS',
  );
  let allowedGuildIds = allowedGuildRead.values;
  if (guildId) {
    if (allowedGuildRead.present && !allowedGuildIds.includes(guildId)) {
      addError(state, 'GUILD_ID must be included in ALLOWED_GUILD_IDS when an allowlist is configured');
    }
    // GUILD_ID remains the legacy single-guild scope and is also the
    // effective allowlist when no separate list is supplied.
    allowedGuildIds = [guildId];
  }

  const dataDir = parseDataDir(state, source, settings.cwd);

  const commerceFulfillmentEnabled = parseBoolean(
    state,
    source,
    ['COMMERCE_FULFILLMENT_ENABLED', 'FULFILLMENT_ENABLED'],
    'COMMERCE_FULFILLMENT_ENABLED',
    false,
  );
  const commerceAllowedProductIds = parseProductIdList(
    state,
    source,
    ['COMMERCE_ALLOWED_PRODUCT_IDS', 'ALLOWED_PRODUCT_IDS'],
    'COMMERCE_ALLOWED_PRODUCT_IDS',
  );
  const commerceSecretRead = readAlias(
    state,
    source,
    [
      'COMMERCE_FULFILLMENT_SHARED_SECRET',
      'COMMERCE_FULFILLMENT_SECRET',
      'COMMERCE_SHARED_SECRET',
      'COMMERCE_INTERNAL_SHARED_SECRET',
      'FULFILLMENT_SHARED_SECRET',
      'INTERNAL_FULFILLMENT_SHARED_SECRET',
    ],
    'COMMERCE_FULFILLMENT_SHARED_SECRET',
    false,
  );
  const commerceSharedSecretPresent = commerceSecretRead.present && commerceSecretRead.value !== undefined;

  if (commerceFulfillmentEnabled) {
    if (commerceAllowedProductIds.length === 0) {
      addError(state, 'COMMERCE_ALLOWED_PRODUCT_IDS is required when commerce fulfillment is enabled');
    }
    if (!commerceSharedSecretPresent) {
      addError(state, 'COMMERCE_FULFILLMENT_SHARED_SECRET is required when commerce fulfillment is enabled');
    }
  }

  if (dashboardPublic) {
    if (dashboardOrigin === null) {
      addError(state, 'DASHBOARD_PUBLIC_ORIGIN is required when the dashboard is public');
    } else if (!dashboardOrigin.startsWith('https://')) {
      addError(state, 'DASHBOARD_PUBLIC_ORIGIN must use https when the dashboard is public');
    }
    if (!dashboardTrustProxy) {
      addError(state, 'DASHBOARD_TRUST_PROXY=true is required when the dashboard is public');
    }
  }

  const config: AppConfig = {
    token,
    clientId,
    guildId,
    dashboardEnabled,
    dashboardHost,
    dashboardPort,
    dashboardTrustProxy,
    dashboardPublic,
    dashboardOrigin,
    allowedGuildIds,
    dataDir,
    commerceFulfillmentEnabled,
    commerceAllowedProductIds,
    commerceSharedSecretPresent,
  };

  return {
    ok: state.errors.length === 0,
    errors: Object.freeze([...state.errors]),
    config,
  };
}

/** Strict parser: throws ConfigValidationError for invalid environment data. */
export function parseConfig(
  env: ConfigEnvironment = currentEnvironment(),
  options: ConfigParseOptions = {},
): AppConfig {
  const result = validateConfig(env, options);
  if (!result.ok) throw new ConfigValidationError(result.errors);
  return result.config;
}

/** Load and strictly validate a supplied environment (or the process env). */
export function loadConfig(
  env: ConfigEnvironment = currentEnvironment(),
  options: ConfigParseOptions = {},
): AppConfig {
  return parseConfig(env, options);
}

/** Return whether a guild is within the configured/effective scope. */
export function isGuildAllowed(config: AppConfig, guildId: string): boolean {
  if (config.allowedGuildIds.length === 0) return true;
  return config.allowedGuildIds.includes(guildId);
}

// Keep the legacy import usable in tests and tools without making validation a
// module-import side effect.  Runtime bootstrap should call loadConfig() when
// it is ready to fail closed on invalid configuration.
const defaultValidation = validateConfig(currentEnvironment(), { strict: false });

/** Default snapshot retained for existing callers; it never logs secret values. */
export const config: AppConfig = defaultValidation.config;

// Descriptive aliases for consumers that prefer environment-oriented naming.
export const parseEnvironment = parseConfig;
export const validateEnvironment = validateConfig;
export const loadEnvironment = loadConfig;
