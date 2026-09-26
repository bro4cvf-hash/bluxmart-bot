require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const {
  ConfigValidationError,
  config,
  isGuildAllowed,
  loadConfig,
  parseConfig,
  validateConfig,
} = require('../../src/config');

const syntheticBase = Object.freeze({
  DISCORD_TOKEN: 'synthetic-discord-token',
  CLIENT_ID: '123456789012345678',
});

const syntheticGuildId = '987654321098765432';
const secondGuildId = '987654321098765433';

function withEnv(overrides = {}) {
  return { ...syntheticBase, ...overrides };
}

test('default values are safe and stable', () => {
  const result = validateConfig(syntheticBase, { cwd: process.cwd() });

  assert.equal(result.ok, true);
  assert.equal(result.config.dashboardEnabled, true);
  assert.equal(result.config.dashboardHost, '127.0.0.1');
  assert.equal(result.config.dashboardPort, 3001);
  assert.equal(result.config.dashboardTrustProxy, false);
  assert.equal(result.config.dashboardPublic, false);
  assert.equal(result.config.dashboardOrigin, null);
  assert.deepEqual(result.config.allowedGuildIds, []);
  assert.equal(result.config.dataDir, path.resolve(process.cwd(), 'data'));
  assert.equal(result.config.commerceFulfillmentEnabled, false);
  assert.deepEqual(result.config.commerceAllowedProductIds, []);
  assert.equal(result.config.commerceSharedSecretPresent, false);
});

const validSettingCases = [
  {
    name: 'explicit dashboard and guild settings',
    env: withEnv({
      GUILD_ID: syntheticGuildId,
      ALLOWED_GUILD_IDS: `${syntheticGuildId},${secondGuildId}`,
      DASHBOARD_ENABLED: 'false',
      DASHBOARD_HOST: '0.0.0.0',
      DASHBOARD_PORT: '8443',
      DASHBOARD_TRUST_PROXY: 'true',
      DASHBOARD_PUBLIC: 'true',
      DASHBOARD_PUBLIC_ORIGIN: 'https://admin.example.test/',
    }),
    check(result) {
      assert.equal(result.config.dashboardEnabled, false);
      assert.equal(result.config.dashboardHost, '0.0.0.0');
      assert.equal(result.config.dashboardPort, 8443);
      assert.equal(result.config.dashboardTrustProxy, true);
      assert.equal(result.config.dashboardPublic, true);
      assert.equal(result.config.dashboardOrigin, 'https://admin.example.test');
      assert.deepEqual(result.config.allowedGuildIds, [syntheticGuildId]);
    },
  },
  {
    name: 'normalized data directory and commerce placeholders',
    env: withEnv({
      DATA_DIR: './runtime/state',
      COMMERCE_FULFILLMENT_ENABLED: 'true',
      COMMERCE_ALLOWED_PRODUCT_IDS: 'prod_alpha,prod_beta',
      COMMERCE_FULFILLMENT_SHARED_SECRET: 'synthetic-internal-secret',
    }),
    check(result) {
      assert.equal(result.config.dataDir, path.resolve(process.cwd(), 'runtime/state'));
      assert.equal(result.config.commerceFulfillmentEnabled, true);
      assert.deepEqual(result.config.commerceAllowedProductIds, ['prod_alpha', 'prod_beta']);
      assert.equal(result.config.commerceSharedSecretPresent, true);
      assert.equal(Object.prototype.hasOwnProperty.call(result.config, 'commerceSharedSecret'), false);
    },
  },
  {
    name: 'multiple allowed guilds without legacy single-guild scope',
    env: withEnv({ ALLOWED_GUILD_IDS: `${syntheticGuildId} ${secondGuildId}` }),
    check(result) {
      assert.deepEqual(result.config.allowedGuildIds, [syntheticGuildId, secondGuildId]);
      assert.equal(isGuildAllowed(result.config, syntheticGuildId), true);
      assert.equal(isGuildAllowed(result.config, '111111111111111111'), false);
    },
  },
  {
    name: 'blank optional placeholders are treated as unset',
    env: withEnv({
      GUILD_ID: '',
      ALLOWED_GUILD_IDS: '',
      COMMERCE_ALLOWED_PRODUCT_IDS: '',
      COMMERCE_FULFILLMENT_SHARED_SECRET: '',
    }),
    check(result) {
      assert.equal(result.config.guildId, '');
      assert.deepEqual(result.config.allowedGuildIds, []);
      assert.deepEqual(result.config.commerceAllowedProductIds, []);
      assert.equal(result.config.commerceSharedSecretPresent, false);
    },
  },
];

for (const testCase of validSettingCases) {
  test(`accepts ${testCase.name}`, () => {
    const result = validateConfig(testCase.env);
    assert.equal(result.ok, true, result.errors.join('; '));
    testCase.check(result);
  });
}

const requiredCases = [
  ['DISCORD_TOKEN', 'DISCORD_TOKEN is required'],
  ['CLIENT_ID', 'CLIENT_ID is required'],
];

for (const [key, expectedError] of requiredCases) {
  test(`requires ${key}`, () => {
    const env = { ...syntheticBase };
    delete env[key];
    const result = validateConfig(env);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(expectedError));
    assert.throws(() => parseConfig(env), ConfigValidationError);
  });
}

test('validation diagnostics never contain token material', () => {
  const secret = 'synthetic-token-that-must-not-be-reported';
  const env = withEnv({ DISCORD_TOKEN: secret, DASHBOARD_PORT: 'not-a-port' });
  const result = validateConfig(env);
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((error) => error.includes(secret)), false);
  try {
    parseConfig(env);
  } catch (error) {
    assert.equal(error.message.includes(secret), false);
  }
});

const invalidCases = [
  {
    name: 'invalid dashboard boolean',
    env: { DASHBOARD_ENABLED: 'yes' },
    error: 'DASHBOARD_ENABLED must be either true or false',
  },
  {
    name: 'invalid dashboard port',
    env: { DASHBOARD_PORT: '70000' },
    error: 'DASHBOARD_PORT must be an integer from 1 to 65535',
  },
  {
    name: 'invalid dashboard host',
    env: { DASHBOARD_HOST: 'http://127.0.0.1' },
    error: 'DASHBOARD_HOST must be a valid host name or IP address',
  },
  {
    name: 'invalid client snowflake',
    env: { CLIENT_ID: 'not-a-snowflake' },
    error: 'CLIENT_ID must be a decimal Discord snowflake',
  },
  {
    name: 'invalid guild snowflake',
    env: { GUILD_ID: 'guild-one' },
    error: 'GUILD_ID must be a decimal Discord snowflake',
  },
  {
    name: 'invalid allowlist snowflake',
    env: { ALLOWED_GUILD_IDS: '111111111111111111,nope' },
    error: 'ALLOWED_GUILD_IDS must be a decimal Discord snowflake',
  },
  {
    name: 'invalid origin',
    env: { DASHBOARD_PUBLIC_ORIGIN: 'https://example.test/path' },
    error: 'DASHBOARD_PUBLIC_ORIGIN must be an absolute origin without a path, query, fragment, or credentials',
  },
  {
    name: 'malformed product list',
    env: { COMMERCE_ALLOWED_PRODUCT_IDS: 'prod_alpha,' },
    error: 'COMMERCE_ALLOWED_PRODUCT_IDS contains an empty list item',
  },
];

for (const testCase of invalidCases) {
  test(`rejects ${testCase.name}`, () => {
    const result = validateConfig(withEnv(testCase.env));
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(testCase.error), result.errors.join('; '));
  });
}

const publicModeCases = [
  {
    name: 'missing origin',
    env: { DASHBOARD_PUBLIC: 'true', DASHBOARD_TRUST_PROXY: 'true' },
    error: 'DASHBOARD_PUBLIC_ORIGIN is required when the dashboard is public',
  },
  {
    name: 'missing trusted proxy',
    env: {
      DASHBOARD_PUBLIC: 'true',
      DASHBOARD_PUBLIC_ORIGIN: 'https://admin.example.test',
    },
    error: 'DASHBOARD_TRUST_PROXY=true is required when the dashboard is public',
  },
  {
    name: 'non-TLS origin',
    env: {
      DASHBOARD_PUBLIC: 'true',
      DASHBOARD_PUBLIC_ORIGIN: 'http://admin.example.test',
      DASHBOARD_TRUST_PROXY: 'true',
    },
    error: 'DASHBOARD_PUBLIC_ORIGIN must use https when the dashboard is public',
  },
];

for (const testCase of publicModeCases) {
  test(`fails closed for public dashboard with ${testCase.name}`, () => {
    const result = validateConfig(withEnv(testCase.env));
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes(testCase.error), result.errors.join('; '));
  });
}

test('commerce enablement requires both allowlist and shared-secret presence', () => {
  const result = validateConfig(withEnv({ COMMERCE_FULFILLMENT_ENABLED: 'true' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('COMMERCE_ALLOWED_PRODUCT_IDS is required when commerce fulfillment is enabled'));
  assert.ok(result.errors.includes('COMMERCE_FULFILLMENT_SHARED_SECRET is required when commerce fulfillment is enabled'));
});

test('loadConfig is strict but accepts a synthetic environment without mutation', () => {
  const env = Object.freeze(withEnv({ DASHBOARD_PORT: '3999' }));
  const loaded = loadConfig(env);
  assert.equal(loaded.dashboardPort, 3999);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'DASHBOARD_HOST'), false);
});

test('the compatibility default is import-safe and does not require credentials', () => {
  assert.equal(typeof config.token, 'string');
  assert.equal(typeof config.clientId, 'string');
  assert.equal(typeof config.dashboardPort, 'number');
});
