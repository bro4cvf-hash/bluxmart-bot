import { toAbortError } from './errors';
import type {
  CategoryInput,
  CategoryPatch,
  CategoryPort,
  CategorySnapshot,
  ChannelInput,
  ChannelPatch,
  ChannelPort,
  ChannelSnapshot,
  CommerceGrantInput,
  CommerceGrantResult,
  CommercePort,
  DiscordPorts,
  MemberPort,
  MemberSnapshot,
  PortContext,
  RoleInput,
  RolePatch,
  RolePosition,
  RolePort,
  RoleSnapshot,
  SetupPort,
  SetupSnapshot,
  SetupState,
  TicketCreateInput,
  TicketPort,
  TicketSnapshot,
} from './types';

function copyRole(role: RoleSnapshot): RoleSnapshot {
  return { ...role, permissions: [...role.permissions] };
}

function copyCategory(category: CategorySnapshot): CategorySnapshot {
  return { ...category };
}

function copyChannel(channel: ChannelSnapshot): ChannelSnapshot {
  return { ...channel };
}

function copyMember(member: MemberSnapshot): MemberSnapshot {
  return { ...member, roleIds: [...member.roleIds] };
}

function copyTicket(ticket: TicketSnapshot): TicketSnapshot {
  return {
    ...ticket,
    ...(ticket.metadata === undefined
      ? {}
      : { metadata: { ...ticket.metadata } }),
  };
}

function copyState(state: SetupState): SetupState {
  return {
    roles: { ...state.roles },
    categories: { ...state.categories },
    channels: { ...state.channels },
  };
}

function scope(guildId: string, key: string): string {
  return `${guildId}\u0000${key}`;
}

function memberScope(guildId: string, userId: string): string {
  return `${guildId}\u0000${userId}`;
}

function productScope(guildId: string, productKey: string): string {
  return `${guildId}\u0000${productKey}`;
}

function abortIfNeeded(context?: PortContext): void {
  if (context?.signal?.aborted) {
    throw toAbortError(context.signal.reason);
  }
}

abstract class FailureInjectingPort {
  private readonly failures: unknown[] = [];

  /** Make the next method call reject with error, then clear the injection. */
  failNext(error: unknown): void {
    this.failures.push(error);
  }

  protected maybeFail(): void {
    if (this.failures.length === 0) return;
    throw this.failures.shift();
  }
}

export class InMemoryRolePort
  extends FailureInjectingPort
  implements RolePort
{
  private readonly byId = new Map<string, RoleSnapshot>();
  private readonly byKey = new Map<string, string>();
  private nextId = 1;

  readonly calls = {
    getById: 0,
    findByKey: 0,
    create: 0,
    update: 0,
    setPositions: 0,
  };

  async getById(
    guildId: string,
    id: string,
    context?: PortContext,
  ): Promise<RoleSnapshot | null> {
    this.calls.getById += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const value = this.byId.get(id);
    return value && value.guildId === guildId ? copyRole(value) : null;
  }

  async findByKey(
    guildId: string,
    key: string,
    context?: PortContext,
  ): Promise<RoleSnapshot | null> {
    this.calls.findByKey += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const id = this.byKey.get(scope(guildId, key));
    const value = id ? this.byId.get(id) : undefined;
    return value ? copyRole(value) : null;
  }

  async create(
    guildId: string,
    input: RoleInput,
    context?: PortContext,
  ): Promise<RoleSnapshot> {
    this.calls.create += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const key = scope(guildId, input.key);
    if (this.byKey.has(key)) throw new Error(`Role key already exists: ${input.key}`);
    const value: RoleSnapshot = {
      id: `role-${this.nextId++}`,
      guildId,
      key: input.key,
      name: input.name,
      permissions: [...(input.permissions ?? [])],
      ...(input.color === undefined ? {} : { color: input.color }),
      ...(input.position === undefined ? {} : { position: input.position }),
      ...(input.hoist === undefined ? {} : { hoist: input.hoist }),
    };
    this.byId.set(value.id, value);
    this.byKey.set(key, value.id);
    return copyRole(value);
  }

  async update(
    guildId: string,
    id: string,
    patch: RolePatch,
    context?: PortContext,
  ): Promise<RoleSnapshot> {
    this.calls.update += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const old = this.byId.get(id);
    if (!old || old.guildId !== guildId) throw new Error(`Unknown role: ${id}`);
    const nextKey = patch.key ?? old.key;
    const nextKeyRef = scope(guildId, nextKey);
    const existingId = this.byKey.get(nextKeyRef);
    if (existingId && existingId !== id) {
      throw new Error(`Role key already exists: ${nextKey}`);
    }
    const next: RoleSnapshot = {
      ...old,
      ...patch,
      id: old.id,
      guildId: old.guildId,
      key: nextKey,
      permissions: patch.permissions
        ? [...patch.permissions]
        : [...old.permissions],
    };
    this.byId.set(id, next);
    this.byKey.delete(scope(guildId, old.key));
    this.byKey.set(nextKeyRef, id);
    return copyRole(next);
  }

  async setPositions(
    guildId: string,
    positions: readonly RolePosition[],
    context?: PortContext,
  ): Promise<void> {
    this.calls.setPositions += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const updates: RoleSnapshot[] = [];
    for (const desired of positions) {
      const role = this.byId.get(desired.id);
      if (!role || role.guildId !== guildId) throw new Error(`Unknown role: ${desired.id}`);
      if (!Number.isInteger(desired.position)) throw new RangeError('position must be an integer');
      updates.push({ ...role, position: desired.position });
    }
    for (const role of updates) this.byId.set(role.id, role);
  }

  all(guildId: string): RoleSnapshot[] {
    return [...this.byId.values()]
      .filter((role) => role.guildId === guildId)
      .map(copyRole);
  }
}

export class InMemoryCategoryPort
  extends FailureInjectingPort
  implements CategoryPort
{
  private readonly byId = new Map<string, CategorySnapshot>();
  private readonly byKey = new Map<string, string>();
  private nextId = 1;

  readonly calls = {
    getById: 0,
    findByKey: 0,
    create: 0,
    update: 0,
  };

  async getById(
    guildId: string,
    id: string,
    context?: PortContext,
  ): Promise<CategorySnapshot | null> {
    this.calls.getById += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const value = this.byId.get(id);
    return value && value.guildId === guildId ? copyCategory(value) : null;
  }

  async findByKey(
    guildId: string,
    key: string,
    context?: PortContext,
  ): Promise<CategorySnapshot | null> {
    this.calls.findByKey += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const id = this.byKey.get(scope(guildId, key));
    const value = id ? this.byId.get(id) : undefined;
    return value ? copyCategory(value) : null;
  }

  async create(
    guildId: string,
    input: CategoryInput,
    context?: PortContext,
  ): Promise<CategorySnapshot> {
    this.calls.create += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const key = scope(guildId, input.key);
    if (this.byKey.has(key)) throw new Error(`Category key already exists: ${input.key}`);
    const value: CategorySnapshot = {
      id: `category-${this.nextId++}`,
      guildId,
      key: input.key,
      name: input.name,
      ...(input.position === undefined ? {} : { position: input.position }),
    };
    this.byId.set(value.id, value);
    this.byKey.set(key, value.id);
    return copyCategory(value);
  }

  async update(
    guildId: string,
    id: string,
    patch: CategoryPatch,
    context?: PortContext,
  ): Promise<CategorySnapshot> {
    this.calls.update += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const old = this.byId.get(id);
    if (!old || old.guildId !== guildId) throw new Error(`Unknown category: ${id}`);
    const nextKey = patch.key ?? old.key;
    const nextKeyRef = scope(guildId, nextKey);
    const existingId = this.byKey.get(nextKeyRef);
    if (existingId && existingId !== id) {
      throw new Error(`Category key already exists: ${nextKey}`);
    }
    const next: CategorySnapshot = {
      ...old,
      ...patch,
      id: old.id,
      guildId: old.guildId,
      key: nextKey,
    };
    this.byId.set(id, next);
    this.byKey.delete(scope(guildId, old.key));
    this.byKey.set(nextKeyRef, id);
    return copyCategory(next);
  }

  all(guildId: string): CategorySnapshot[] {
    return [...this.byId.values()]
      .filter((category) => category.guildId === guildId)
      .map(copyCategory);
  }
}

export class InMemoryChannelPort
  extends FailureInjectingPort
  implements ChannelPort
{
  private readonly byId = new Map<string, ChannelSnapshot>();
  private readonly byKey = new Map<string, string>();
  private nextId = 1;

  readonly calls = {
    getById: 0,
    findByKey: 0,
    create: 0,
    update: 0,
  };

  async getById(
    guildId: string,
    id: string,
    context?: PortContext,
  ): Promise<ChannelSnapshot | null> {
    this.calls.getById += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const value = this.byId.get(id);
    return value && value.guildId === guildId ? copyChannel(value) : null;
  }

  async findByKey(
    guildId: string,
    key: string,
    context?: PortContext,
  ): Promise<ChannelSnapshot | null> {
    this.calls.findByKey += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const id = this.byKey.get(scope(guildId, key));
    const value = id ? this.byId.get(id) : undefined;
    return value ? copyChannel(value) : null;
  }

  async create(
    guildId: string,
    input: ChannelInput,
    context?: PortContext,
  ): Promise<ChannelSnapshot> {
    this.calls.create += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const key = scope(guildId, input.key);
    if (this.byKey.has(key)) throw new Error(`Channel key already exists: ${input.key}`);
    const value: ChannelSnapshot = {
      id: `channel-${this.nextId++}`,
      guildId,
      key: input.key,
      name: input.name,
      type: input.type,
      ...(input.parentKey === undefined ? {} : { parentKey: input.parentKey }),
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      ...(input.position === undefined ? {} : { position: input.position }),
    };
    this.byId.set(value.id, value);
    this.byKey.set(key, value.id);
    return copyChannel(value);
  }

  async update(
    guildId: string,
    id: string,
    patch: ChannelPatch,
    context?: PortContext,
  ): Promise<ChannelSnapshot> {
    this.calls.update += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const old = this.byId.get(id);
    if (!old || old.guildId !== guildId) throw new Error(`Unknown channel: ${id}`);
    const nextKey = patch.key ?? old.key;
    const nextKeyRef = scope(guildId, nextKey);
    const existingId = this.byKey.get(nextKeyRef);
    if (existingId && existingId !== id) {
      throw new Error(`Channel key already exists: ${nextKey}`);
    }
    const next: ChannelSnapshot = {
      ...old,
      ...patch,
      id: old.id,
      guildId: old.guildId,
      key: nextKey,
    };
    this.byId.set(id, next);
    this.byKey.delete(scope(guildId, old.key));
    this.byKey.set(nextKeyRef, id);
    return copyChannel(next);
  }

  all(guildId: string): ChannelSnapshot[] {
    return [...this.byId.values()]
      .filter((channel) => channel.guildId === guildId)
      .map(copyChannel);
  }
}

export class InMemorySetupPort extends FailureInjectingPort implements SetupPort {
  readonly roles: RolePort;
  readonly categories: CategoryPort;
  readonly channels: ChannelPort;
  private readonly states = new Map<string, SetupSnapshot>();
  private nextRevision = 1;

  readonly calls = {
    load: 0,
    save: 0,
  };

  constructor(options?: {
    readonly roles?: RolePort;
    readonly categories?: CategoryPort;
    readonly channels?: ChannelPort;
  }) {
    super();
    this.roles = options?.roles ?? new InMemoryRolePort();
    this.categories = options?.categories ?? new InMemoryCategoryPort();
    this.channels = options?.channels ?? new InMemoryChannelPort();
  }

  async load(guildId: string, context?: PortContext): Promise<SetupSnapshot | null> {
    this.calls.load += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const value = this.states.get(guildId);
    return value
      ? {
          ...copyState(value),
          guildId: value.guildId,
          ...(value.revision === undefined ? {} : { revision: value.revision }),
        }
      : null;
  }

  async save(guildId: string, state: SetupState, context?: PortContext): Promise<void> {
    this.calls.save += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const previous = this.states.get(guildId);
    const revision = Math.max(this.nextRevision, (previous?.revision ?? 0) + 1);
    this.nextRevision = revision + 1;
    this.states.set(guildId, {
      ...copyState(state),
      guildId,
      revision,
    });
  }

  seed(guildId: string, state: SetupState, revision?: number): void {
    this.states.set(guildId, {
      ...copyState(state),
      guildId,
      ...(revision === undefined ? {} : { revision }),
    });
  }
}

export class InMemoryTicketPort extends FailureInjectingPort implements TicketPort {
  private readonly byId = new Map<string, TicketSnapshot>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly openByScope = new Map<string, string>();
  private nextId = 1;

  readonly calls = {
    findOpen: 0,
    create: 0,
    close: 0,
  };

  async findOpen(
    guildId: string,
    userId: string,
    typeId: string,
    context?: PortContext,
  ): Promise<TicketSnapshot | null> {
    this.calls.findOpen += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const id = this.openByScope.get(`${guildId}\u0000${userId}\u0000${typeId}`);
    const value = id ? this.byId.get(id) : undefined;
    return value && value.status === 'open' ? copyTicket(value) : null;
  }

  async create(input: TicketCreateInput, context?: PortContext): Promise<TicketSnapshot> {
    this.calls.create += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const key = `${input.guildId}\u0000${input.userId}\u0000${input.typeId}`;
    if (input.idempotencyKey && this.byIdempotencyKey.has(input.idempotencyKey)) {
      throw new Error('A ticket already exists for this idempotency key');
    }
    if (this.openByScope.has(key)) {
      throw new Error('An open ticket already exists for this user and type');
    }
    const value: TicketSnapshot = {
      id: `ticket-${this.nextId++}`,
      guildId: input.guildId,
      userId: input.userId,
      typeId: input.typeId,
      topic: input.topic,
      status: 'open',
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
      ...(input.categoryKey === undefined ? {} : { categoryKey: input.categoryKey }),
      ...(input.metadata === undefined
        ? {}
        : { metadata: { ...input.metadata } }),
    };
    this.byId.set(value.id, value);
    if (input.idempotencyKey) this.byIdempotencyKey.set(input.idempotencyKey, value.id);
    this.openByScope.set(key, value.id);
    return copyTicket(value);
  }

  async close(guildId: string, ticketId: string, context?: PortContext): Promise<TicketSnapshot> {
    this.calls.close += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const old = this.byId.get(ticketId);
    if (!old || old.guildId !== guildId) throw new Error(`Unknown ticket: ${ticketId}`);
    const next: TicketSnapshot = { ...old, status: 'closed' };
    this.byId.set(ticketId, next);
    this.openByScope.delete(`${guildId}\u0000${old.userId}\u0000${old.typeId}`);
    return copyTicket(next);
  }

  get(ticketId: string): TicketSnapshot | null {
    const value = this.byId.get(ticketId);
    return value ? copyTicket(value) : null;
  }

  getByIdempotencyKey(idempotencyKey: string): TicketSnapshot | null {
    const id = this.byIdempotencyKey.get(idempotencyKey);
    const value = id ? this.byId.get(id) : undefined;
    return value ? copyTicket(value) : null;
  }

  all(): TicketSnapshot[] {
    return [...this.byId.values()].map(copyTicket);
  }
}

export class InMemoryMemberPort extends FailureInjectingPort implements MemberPort {
  private readonly members = new Map<string, MemberSnapshot>();

  readonly calls = {
    find: 0,
    addRole: 0,
    removeRole: 0,
  };

  seed(guildId: string, userId: string, roleIds: readonly string[] = []): MemberSnapshot {
    const value: MemberSnapshot = {
      id: userId,
      guildId,
      roleIds: [...new Set(roleIds)],
    };
    this.members.set(memberScope(guildId, userId), value);
    return copyMember(value);
  }

  async find(
    guildId: string,
    userId: string,
    context?: PortContext,
  ): Promise<MemberSnapshot | null> {
    this.calls.find += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const value = this.members.get(memberScope(guildId, userId));
    return value ? copyMember(value) : null;
  }

  async addRole(
    guildId: string,
    userId: string,
    roleId: string,
    context?: PortContext,
  ): Promise<MemberSnapshot> {
    this.calls.addRole += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const key = memberScope(guildId, userId);
    const old = this.members.get(key);
    if (!old) throw new Error(`Unknown member: ${userId}`);
    const value: MemberSnapshot = {
      ...old,
      roleIds: old.roleIds.includes(roleId) ? [...old.roleIds] : [...old.roleIds, roleId],
    };
    this.members.set(key, value);
    return copyMember(value);
  }

  async removeRole(
    guildId: string,
    userId: string,
    roleId: string,
    context?: PortContext,
  ): Promise<MemberSnapshot> {
    this.calls.removeRole += 1;
    abortIfNeeded(context);
    this.maybeFail();
    const key = memberScope(guildId, userId);
    const old = this.members.get(key);
    if (!old) throw new Error(`Unknown member: ${userId}`);
    const value: MemberSnapshot = {
      ...old,
      roleIds: old.roleIds.filter((id) => id !== roleId),
    };
    this.members.set(key, value);
    return copyMember(value);
  }
}

export interface InMemoryCommerceOptions {
  readonly members: MemberPort;
  readonly customerRoles?: Readonly<Record<string, RoleSnapshot>>;
}

export class InMemoryCommercePort implements CommercePort {
  private readonly members: MemberPort;
  private readonly customerRoles: Map<string, RoleSnapshot>;
  private readonly grants = new Map<string, CommerceGrantResult>();
  private nextRequest = 1;

  readonly calls = {
    resolveCustomerRole: 0,
    grantCustomerRole: 0,
  };

  constructor(options: InMemoryCommerceOptions) {
    this.members = options.members;
    this.customerRoles = new Map();
    for (const [key, role] of Object.entries(options.customerRoles ?? {})) {
      this.customerRoles.set(key, copyRole(role));
    }
  }

  setCustomerRole(guildId: string, productKey: string, role: RoleSnapshot): void {
    this.customerRoles.set(productScope(guildId, productKey), copyRole(role));
  }

  async resolveCustomerRole(
    guildId: string,
    productKey: string,
    context?: PortContext,
  ): Promise<RoleSnapshot | null> {
    this.calls.resolveCustomerRole += 1;
    abortIfNeeded(context);
    const role = this.customerRoles.get(productScope(guildId, productKey));
    return role ? copyRole(role) : null;
  }

  async grantCustomerRole(
    input: CommerceGrantInput,
    context?: PortContext,
  ): Promise<CommerceGrantResult> {
    this.calls.grantCustomerRole += 1;
    abortIfNeeded(context);
    const previous = this.grants.get(input.idempotencyKey);
    if (previous && previous.outcome !== 'pending_member') {
      return { ...previous, ...(previous.member ? { member: copyMember(previous.member) } : {}) };
    }

    const role = input.roleId
      ? [...this.customerRoles.values()].find(
          (candidate) =>
            candidate.guildId === input.guildId && candidate.id === input.roleId,
        )
      : await this.resolveCustomerRole(input.guildId, input.productKey, context);
    const base = {
      idempotencyKey: input.idempotencyKey,
      guildId: input.guildId,
      userId: input.userId,
      ...(role ? { roleId: role.id } : {}),
    } as const;

    if (!role) {
      // Role resolution can become available after a template/live-sync
      // repair. Do not make a missing role a permanent idempotency terminal.
      return {
        ...base,
        outcome: 'role_not_found',
      };
    }

    const member = await this.members.find(input.guildId, input.userId, context);
    if (!member) {
      const result: CommerceGrantResult = {
        ...base,
        outcome: 'pending_member',
      };
      this.grants.set(input.idempotencyKey, result);
      return result;
    }

    const updated = member.roleIds.includes(role.id)
      ? member
      : await this.members.addRole(input.guildId, input.userId, role.id, context);
    const result: CommerceGrantResult = {
      ...base,
      outcome: member.roleIds.includes(role.id) ? 'already_granted' : 'granted',
      member: copyMember(updated),
    };
    this.grants.set(input.idempotencyKey, result);
    return result;
  }

  /** Test-only inspection without exposing mutable internal state. */
  grantCount(): number {
    return this.grants.size;
  }

  nextSyntheticRequestId(): string {
    return `commerce-request-${this.nextRequest++}`;
  }
}

export interface InMemoryPorts extends DiscordPorts {
  readonly setup: InMemorySetupPort;
  readonly tickets: InMemoryTicketPort;
  readonly members: InMemoryMemberPort;
  readonly commerce: InMemoryCommercePort;
}

export function createInMemoryPorts(): InMemoryPorts {
  const setup = new InMemorySetupPort();
  const tickets = new InMemoryTicketPort();
  const members = new InMemoryMemberPort();
  const commerce = new InMemoryCommercePort({ members });
  return { setup, tickets, members, commerce };
}

export const createFakePorts = createInMemoryPorts;
export type FakePorts = InMemoryPorts;
