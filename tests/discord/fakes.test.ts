import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInMemoryPorts,
  InMemoryCommercePort,
  InMemoryMemberPort,
} from '../../src/lib/discord/fakes';

test('provides deterministic structural fakes for setup, tickets, and members', async () => {
  const ports = createInMemoryPorts();
  const role = await ports.setup.roles.create('synthetic-guild', {
    key: 'customer',
    name: 'Customer',
    permissions: ['read'],
  });
  assert.equal((await ports.setup.roles.findByKey('synthetic-guild', 'customer'))?.id, role.id);

  const ticket = await ports.tickets.create({
    guildId: 'synthetic-guild',
    userId: 'synthetic-user',
    typeId: 'support',
    name: 'synthetic-ticket',
    topic: 'ticket:synthetic',
  });
  assert.equal((await ports.tickets.findOpen('synthetic-guild', 'synthetic-user', 'support'))?.id, ticket.id);
  await assert.rejects(
    ports.tickets.create({
      guildId: 'synthetic-guild',
      userId: 'synthetic-user',
      typeId: 'support',
      name: 'duplicate',
      topic: 'ticket:duplicate',
    }),
  );
  await ports.tickets.close('synthetic-guild', ticket.id);
  assert.equal(await ports.tickets.findOpen('synthetic-guild', 'synthetic-user', 'support'), null);

  ports.commerce.setCustomerRole('synthetic-guild', 'customer', role);
  ports.members.seed('synthetic-guild', 'synthetic-user');
  const granted = await ports.commerce.grantCustomerRole({
    idempotencyKey: 'synthetic-order-1',
    guildId: 'synthetic-guild',
    userId: 'synthetic-user',
    productKey: 'customer',
  });
  assert.equal(granted.outcome, 'granted');
  assert.deepEqual(granted.member?.roleIds, [role.id]);
});

test('commerce fake keeps fulfillment pending until a member exists', async () => {
  const members = new InMemoryMemberPort();
  const commerce = new InMemoryCommercePort({ members });
  const role = {
    id: 'synthetic-role',
    guildId: 'synthetic-guild',
    key: 'customer',
    name: 'Customer',
    permissions: [],
  };
  commerce.setCustomerRole('synthetic-guild', 'customer', role);

  const input = {
    idempotencyKey: 'synthetic-order-2',
    guildId: 'synthetic-guild',
    userId: 'synthetic-user',
    productKey: 'customer',
  };
  const pending = await commerce.grantCustomerRole(input);
  assert.equal(pending.outcome, 'pending_member');

  members.seed('synthetic-guild', 'synthetic-user');
  const fulfilled = await commerce.grantCustomerRole(input);
  assert.equal(fulfilled.outcome, 'granted');
  assert.deepEqual(fulfilled.member?.roleIds, ['synthetic-role']);
});
