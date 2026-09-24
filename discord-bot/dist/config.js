"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadEnvironment = exports.validateEnvironment = exports.parseEnvironment = exports.config = exports.DEFAULT_DATA_DIR = exports.DEFAULT_DATA_DIR_NAME = exports.DEFAULT_DASHBOARD_PORT = exports.DEFAULT_DASHBOARD_HOST = exports.ConfigValidationError = void 0;
exports.validateConfig = validateConfig;
exports.parseConfig = parseConfig;
exports.loadConfig = loadConfig;
exports.isGuildAllowed = isGuildAllowed;
require("dotenv/config");
const path_1 = __importDefault(require("path"));
const net_1 = require("net");
class ConfigValidationError extends Error {
    errors;
    constructor(errors) {
        super(`Invalid configuration: ${errors.join('; ')}`);
        this.name = 'ConfigValidationError';
        this.errors = Object.freeze([...errors]);
    }
}
exports.ConfigValidationError = ConfigValidationError;
function defaultCwd() {
    return process.cwd();
}
exports.DEFAULT_DASHBOARD_HOST = '127.0.0.1';
exports.DEFAULT_DASHBOARD_PORT = 3001;
exports.DEFAULT_DATA_DIR_NAME = 'data';
exports.DEFAULT_DATA_DIR = path_1.default.resolve(defaultCwd(), exports.DEFAULT_DATA_DIR_NAME);
const DISCORD_ID_PATTERN = /^\d{1,20}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const PRODUCT_ID_MAX_LENGTH = 256;
function currentEnvironment() {
    // Keep the process environment behind this single boundary.
    return process.env;
}
function addError(state, message) {
    state.errors.push(message);
}
function environmentValue(env, key) {
    return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}
/**
 * Read the first configured alias without ever putting its value in an error.
 * Conflicting aliases fail closed rather than making security-sensitive
 * behavior depend on key order.
 */
function readAlias(state, env, keys, label, emptyIsError = true) {
    const values = [];
    let present = false;
    for (const key of keys) {
        const raw = environmentValue(env, key);
        if (raw === undefined)
            continue;
        present = true;
        if (typeof raw !== 'string') {
            addError(state, `${label} must be a string`);
            continue;
        }
        const value = raw.trim();
        if (!value) {
            if (emptyIsError)
                addError(state, `${label} must not be empty`);
            continue;
        }
        values.push(value);
    }
    if (!present)
        return { present: false };
    if (new Set(values).size > 1) {
        addError(state, `${label} has conflicting values`);
    }
    return { present: true, value: values[0] };
}
function readString(state, env, keys, label, required) {
    const read = readAlias(state, env, keys, label, required);
    if (!read.present) {
        if (required)
            addError(state, `${label} is required`);
        return '';
    }
    if (read.value === undefined)
        return '';
    if (CONTROL_CHARACTER_PATTERN.test(read.value) || /\s/.test(read.value)) {
        addError(state, `${label} must not contain whitespace or control characters`);
        return '';
    }
    return read.value;
}
function parseBoolean(state, env, keys, label, fallback) {
    const read = readAlias(state, env, keys, label);
    if (!read.present || read.value === undefined)
        return fallback;
    const value = read.value.toLowerCase();
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    addError(state, `${label} must be either true or false`);
    return fallback;
}
function parsePort(state, env, keys, label, fallback) {
    const read = readAlias(state, env, keys, label);
    if (!read.present)
        return fallback;
    if (read.value === undefined)
        return fallback;
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
function isValidHost(host) {
    if (!host || host.length > 253)
        return false;
    if (CONTROL_CHARACTER_PATTERN.test(host) || /\s/.test(host))
        return false;
    if (host.includes('/') || host.includes('\\') || host.includes(':') && (0, net_1.isIP)(host) === 0) {
        return false;
    }
    if ((0, net_1.isIP)(host) !== 0)
        return true;
    if (host.startsWith('.') || host.endsWith('.') || host.includes('..'))
        return false;
    return host.split('.').every((label) => SAFE_HOST_LABEL_PATTERN.test(label));
}
function parseHost(state, env, keys, label, fallback) {
    const read = readAlias(state, env, keys, label);
    if (!read.present)
        return fallback;
    if (read.value === undefined)
        return fallback;
    if (!isValidHost(read.value)) {
        addError(state, `${label} must be a valid host name or IP address`);
        return fallback;
    }
    return read.value;
}
function parseOrigin(state, env, keys, label) {
    const read = readAlias(state, env, keys, label, false);
    if (!read.present)
        return null;
    if (read.value === undefined)
        return null;
    let parsed;
    try {
        parsed = new URL(read.value);
    }
    catch {
        addError(state, `${label} must be an absolute http(s) origin`);
        return null;
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username !== '' ||
        parsed.password !== '' ||
        parsed.pathname !== '/' ||
        parsed.search !== '' ||
        parsed.hash !== '') {
        addError(state, `${label} must be an absolute origin without a path, query, fragment, or credentials`);
        return null;
    }
    return parsed.origin;
}
function parseDiscordId(state, value, label) {
    if (value === undefined || value === '')
        return undefined;
    if (!DISCORD_ID_PATTERN.test(value) || /^0+$/.test(value)) {
        addError(state, `${label} must be a decimal Discord snowflake`);
        return undefined;
    }
    return value;
}
function splitList(state, value, label) {
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
    if (malformed)
        addError(state, `${label} contains an empty list item`);
    if (values.length === 0) {
        addError(state, `${label} must not be empty`);
        return [];
    }
    return values;
}
function parseDiscordIdList(state, env, keys, label) {
    const read = readAlias(state, env, keys, label, false);
    if (!read.present)
        return { present: false, values: [] };
    if (read.value === undefined)
        return { present: false, values: [] };
    const values = splitList(state, read.value, label);
    const valid = [];
    for (const value of values) {
        const parsed = parseDiscordId(state, value, label);
        if (parsed !== undefined)
            valid.push(parsed);
    }
    return { present: true, values: [...new Set(valid)] };
}
function parseProductIdList(state, env, keys, label) {
    const read = readAlias(state, env, keys, label, false);
    if (!read.present)
        return [];
    if (read.value === undefined)
        return [];
    const values = splitList(state, read.value, label);
    const valid = [];
    for (const value of values) {
        if (value.length > PRODUCT_ID_MAX_LENGTH ||
            CONTROL_CHARACTER_PATTERN.test(value) ||
            /\s/.test(value)) {
            addError(state, `${label} must contain only non-empty opaque product identifiers`);
            continue;
        }
        valid.push(value);
    }
    return [...new Set(valid)];
}
function parseDataDir(state, env, cwd) {
    const read = readAlias(state, env, ['DATA_DIR'], 'DATA_DIR', false);
    if (!read.present)
        return path_1.default.resolve(cwd, exports.DEFAULT_DATA_DIR_NAME);
    if (read.value === undefined)
        return path_1.default.resolve(cwd, exports.DEFAULT_DATA_DIR_NAME);
    if (read.value.includes('\0')) {
        addError(state, 'DATA_DIR must be a valid filesystem path');
        return path_1.default.resolve(cwd, exports.DEFAULT_DATA_DIR_NAME);
    }
    return path_1.default.resolve(cwd, read.value);
}
function normalizeOptions(options) {
    const value = options ?? {};
    const strict = value.strict ?? true;
    return {
        cwd: value.cwd ?? path_1.default.dirname(exports.DEFAULT_DATA_DIR),
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
function validateConfig(env = currentEnvironment(), options = {}) {
    const state = { errors: [] };
    const settings = normalizeOptions(options);
    const source = env && typeof env === 'object' ? env : {};
    const token = readString(state, source, ['DISCORD_TOKEN'], 'DISCORD_TOKEN', settings.requireDiscordToken);
    const clientIdValue = readString(state, source, ['CLIENT_ID'], 'CLIENT_ID', settings.requireClientId);
    const clientId = parseDiscordId(state, clientIdValue || undefined, 'CLIENT_ID') ?? '';
    const guildIdValue = readString(state, source, ['GUILD_ID'], 'GUILD_ID', false);
    const guildId = parseDiscordId(state, guildIdValue || undefined, 'GUILD_ID') ?? '';
    const dashboardEnabled = parseBoolean(state, source, ['DASHBOARD_ENABLED'], 'DASHBOARD_ENABLED', true);
    const dashboardHost = parseHost(state, source, ['DASHBOARD_HOST', 'DASHBOARD_BIND_HOST'], 'DASHBOARD_HOST', exports.DEFAULT_DASHBOARD_HOST);
    const dashboardPort = parsePort(state, source, ['DASHBOARD_PORT'], 'DASHBOARD_PORT', exports.DEFAULT_DASHBOARD_PORT);
    const dashboardTrustProxy = parseBoolean(state, source, ['DASHBOARD_TRUST_PROXY', 'DASHBOARD_TRUSTED_PROXY'], 'DASHBOARD_TRUST_PROXY', false);
    const dashboardPublic = parseBoolean(state, source, ['DASHBOARD_PUBLIC'], 'DASHBOARD_PUBLIC', false);
    const dashboardOrigin = parseOrigin(state, source, ['DASHBOARD_PUBLIC_ORIGIN', 'DASHBOARD_ORIGIN', 'DASHBOARD_PUBLIC_URL'], 'DASHBOARD_PUBLIC_ORIGIN');
    const allowedGuildRead = parseDiscordIdList(state, source, ['ALLOWED_GUILD_IDS', 'GUILD_ALLOWLIST', 'ALLOWED_GUILDS'], 'ALLOWED_GUILD_IDS');
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
    const commerceFulfillmentEnabled = parseBoolean(state, source, ['COMMERCE_FULFILLMENT_ENABLED', 'FULFILLMENT_ENABLED'], 'COMMERCE_FULFILLMENT_ENABLED', false);
    const commerceAllowedProductIds = parseProductIdList(state, source, ['COMMERCE_ALLOWED_PRODUCT_IDS', 'ALLOWED_PRODUCT_IDS'], 'COMMERCE_ALLOWED_PRODUCT_IDS');
    const commerceSecretRead = readAlias(state, source, [
        'COMMERCE_FULFILLMENT_SHARED_SECRET',
        'COMMERCE_FULFILLMENT_SECRET',
        'COMMERCE_SHARED_SECRET',
        'COMMERCE_INTERNAL_SHARED_SECRET',
        'FULFILLMENT_SHARED_SECRET',
        'INTERNAL_FULFILLMENT_SHARED_SECRET',
    ], 'COMMERCE_FULFILLMENT_SHARED_SECRET', false);
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
        }
        else if (!dashboardOrigin.startsWith('https://')) {
            addError(state, 'DASHBOARD_PUBLIC_ORIGIN must use https when the dashboard is public');
        }
        if (!dashboardTrustProxy) {
            addError(state, 'DASHBOARD_TRUST_PROXY=true is required when the dashboard is public');
        }
    }
    const config = {
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
function parseConfig(env = currentEnvironment(), options = {}) {
    const result = validateConfig(env, options);
    if (!result.ok)
        throw new ConfigValidationError(result.errors);
    return result.config;
}
/** Load and strictly validate a supplied environment (or the process env). */
function loadConfig(env = currentEnvironment(), options = {}) {
    return parseConfig(env, options);
}
/** Return whether a guild is within the configured/effective scope. */
function isGuildAllowed(config, guildId) {
    if (config.allowedGuildIds.length === 0)
        return true;
    return config.allowedGuildIds.includes(guildId);
}
// Keep the legacy import usable in tests and tools without making validation a
// module-import side effect.  Runtime bootstrap should call loadConfig() when
// it is ready to fail closed on invalid configuration.
const defaultValidation = validateConfig(currentEnvironment(), { strict: false });
/** Default snapshot retained for existing callers; it never logs secret values. */
exports.config = defaultValidation.config;
// Descriptive aliases for consumers that prefer environment-oriented naming.
exports.parseEnvironment = parseConfig;
exports.validateEnvironment = validateConfig;
exports.loadEnvironment = loadConfig;
