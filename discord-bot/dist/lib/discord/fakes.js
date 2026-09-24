"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFakePorts = exports.InMemoryCommercePort = exports.InMemoryMemberPort = exports.InMemoryTicketPort = exports.InMemorySetupPort = exports.InMemoryChannelPort = exports.InMemoryCategoryPort = exports.InMemoryRolePort = void 0;
exports.createInMemoryPorts = createInMemoryPorts;
const errors_1 = require("./errors");
function copyRole(role) {
    return { ...role, permissions: [...role.permissions] };
}
function copyCategory(category) {
    return { ...category };
}
function copyChannel(channel) {
    return { ...channel };
}
function copyMember(member) {
    return { ...member, roleIds: [...member.roleIds] };
}
function copyTicket(ticket) {
    return {
        ...ticket,
        ...(ticket.metadata === undefined
            ? {}
            : { metadata: { ...ticket.metadata } }),
    };
}
function copyState(state) {
    return {
        roles: { ...state.roles },
        categories: { ...state.categories },
        channels: { ...state.channels },
    };
}
function scope(guildId, key) {
    return `${guildId}\u0000${key}`;
}
function memberScope(guildId, userId) {
    return `${guildId}\u0000${userId}`;
}
function productScope(guildId, productKey) {
    return `${guildId}\u0000${productKey}`;
}
function abortIfNeeded(context) {
    if (context?.signal?.aborted) {
        throw (0, errors_1.toAbortError)(context.signal.reason);
    }
}
class FailureInjectingPort {
    failures = [];
    /** Make the next method call reject with error, then clear the injection. */
    failNext(error) {
        this.failures.push(error);
    }
    maybeFail() {
        if (this.failures.length === 0)
            return;
        throw this.failures.shift();
    }
}
class InMemoryRolePort extends FailureInjectingPort {
    byId = new Map();
    byKey = new Map();
    nextId = 1;
    calls = {
        getById: 0,
        findByKey: 0,
        create: 0,
        update: 0,
        setPositions: 0,
    };
    async getById(guildId, id, context) {
        this.calls.getById += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const value = this.byId.get(id);
        return value && value.guildId === guildId ? copyRole(value) : null;
    }
    async findByKey(guildId, key, context) {
        this.calls.findByKey += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const id = this.byKey.get(scope(guildId, key));
        const value = id ? this.byId.get(id) : undefined;
        return value ? copyRole(value) : null;
    }
    async create(guildId, input, context) {
        this.calls.create += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const key = scope(guildId, input.key);
        if (this.byKey.has(key))
            throw new Error(`Role key already exists: ${input.key}`);
        const value = {
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
    async update(guildId, id, patch, context) {
        this.calls.update += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const old = this.byId.get(id);
        if (!old || old.guildId !== guildId)
            throw new Error(`Unknown role: ${id}`);
        const nextKey = patch.key ?? old.key;
        const nextKeyRef = scope(guildId, nextKey);
        const existingId = this.byKey.get(nextKeyRef);
        if (existingId && existingId !== id) {
            throw new Error(`Role key already exists: ${nextKey}`);
        }
        const next = {
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
    async setPositions(guildId, positions, context) {
        this.calls.setPositions += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const updates = [];
        for (const desired of positions) {
            const role = this.byId.get(desired.id);
            if (!role || role.guildId !== guildId)
                throw new Error(`Unknown role: ${desired.id}`);
            if (!Number.isInteger(desired.position))
                throw new RangeError('position must be an integer');
            updates.push({ ...role, position: desired.position });
        }
        for (const role of updates)
            this.byId.set(role.id, role);
    }
    all(guildId) {
        return [...this.byId.values()]
            .filter((role) => role.guildId === guildId)
            .map(copyRole);
    }
}
exports.InMemoryRolePort = InMemoryRolePort;
class InMemoryCategoryPort extends FailureInjectingPort {
    byId = new Map();
    byKey = new Map();
    nextId = 1;
    calls = {
        getById: 0,
        findByKey: 0,
        create: 0,
        update: 0,
    };
    async getById(guildId, id, context) {
        this.calls.getById += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const value = this.byId.get(id);
        return value && value.guildId === guildId ? copyCategory(value) : null;
    }
    async findByKey(guildId, key, context) {
        this.calls.findByKey += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const id = this.byKey.get(scope(guildId, key));
        const value = id ? this.byId.get(id) : undefined;
        return value ? copyCategory(value) : null;
    }
    async create(guildId, input, context) {
        this.calls.create += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const key = scope(guildId, input.key);
        if (this.byKey.has(key))
            throw new Error(`Category key already exists: ${input.key}`);
        const value = {
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
    async update(guildId, id, patch, context) {
        this.calls.update += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const old = this.byId.get(id);
        if (!old || old.guildId !== guildId)
            throw new Error(`Unknown category: ${id}`);
        const nextKey = patch.key ?? old.key;
        const nextKeyRef = scope(guildId, nextKey);
        const existingId = this.byKey.get(nextKeyRef);
        if (existingId && existingId !== id) {
            throw new Error(`Category key already exists: ${nextKey}`);
        }
        const next = {
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
    all(guildId) {
        return [...this.byId.values()]
            .filter((category) => category.guildId === guildId)
            .map(copyCategory);
    }
}
exports.InMemoryCategoryPort = InMemoryCategoryPort;
class InMemoryChannelPort extends FailureInjectingPort {
    byId = new Map();
    byKey = new Map();
    nextId = 1;
    calls = {
        getById: 0,
        findByKey: 0,
        create: 0,
        update: 0,
    };
    async getById(guildId, id, context) {
        this.calls.getById += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const value = this.byId.get(id);
        return value && value.guildId === guildId ? copyChannel(value) : null;
    }
    async findByKey(guildId, key, context) {
        this.calls.findByKey += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const id = this.byKey.get(scope(guildId, key));
        const value = id ? this.byId.get(id) : undefined;
        return value ? copyChannel(value) : null;
    }
    async create(guildId, input, context) {
        this.calls.create += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const key = scope(guildId, input.key);
        if (this.byKey.has(key))
            throw new Error(`Channel key already exists: ${input.key}`);
        const value = {
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
    async update(guildId, id, patch, context) {
        this.calls.update += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const old = this.byId.get(id);
        if (!old || old.guildId !== guildId)
            throw new Error(`Unknown channel: ${id}`);
        const nextKey = patch.key ?? old.key;
        const nextKeyRef = scope(guildId, nextKey);
        const existingId = this.byKey.get(nextKeyRef);
        if (existingId && existingId !== id) {
            throw new Error(`Channel key already exists: ${nextKey}`);
        }
        const next = {
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
    all(guildId) {
        return [...this.byId.values()]
            .filter((channel) => channel.guildId === guildId)
            .map(copyChannel);
    }
}
exports.InMemoryChannelPort = InMemoryChannelPort;
class InMemorySetupPort extends FailureInjectingPort {
    roles;
    categories;
    channels;
    states = new Map();
    nextRevision = 1;
    calls = {
        load: 0,
        save: 0,
    };
    constructor(options) {
        super();
        this.roles = options?.roles ?? new InMemoryRolePort();
        this.categories = options?.categories ?? new InMemoryCategoryPort();
        this.channels = options?.channels ?? new InMemoryChannelPort();
    }
    async load(guildId, context) {
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
    async save(guildId, state, context) {
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
    seed(guildId, state, revision) {
        this.states.set(guildId, {
            ...copyState(state),
            guildId,
            ...(revision === undefined ? {} : { revision }),
        });
    }
}
exports.InMemorySetupPort = InMemorySetupPort;
class InMemoryTicketPort extends FailureInjectingPort {
    byId = new Map();
    byIdempotencyKey = new Map();
    openByScope = new Map();
    nextId = 1;
    calls = {
        findOpen: 0,
        create: 0,
        close: 0,
    };
    async findOpen(guildId, userId, typeId, context) {
        this.calls.findOpen += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const id = this.openByScope.get(`${guildId}\u0000${userId}\u0000${typeId}`);
        const value = id ? this.byId.get(id) : undefined;
        return value && value.status === 'open' ? copyTicket(value) : null;
    }
    async create(input, context) {
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
        const value = {
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
        if (input.idempotencyKey)
            this.byIdempotencyKey.set(input.idempotencyKey, value.id);
        this.openByScope.set(key, value.id);
        return copyTicket(value);
    }
    async close(guildId, ticketId, context) {
        this.calls.close += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const old = this.byId.get(ticketId);
        if (!old || old.guildId !== guildId)
            throw new Error(`Unknown ticket: ${ticketId}`);
        const next = { ...old, status: 'closed' };
        this.byId.set(ticketId, next);
        this.openByScope.delete(`${guildId}\u0000${old.userId}\u0000${old.typeId}`);
        return copyTicket(next);
    }
    get(ticketId) {
        const value = this.byId.get(ticketId);
        return value ? copyTicket(value) : null;
    }
    getByIdempotencyKey(idempotencyKey) {
        const id = this.byIdempotencyKey.get(idempotencyKey);
        const value = id ? this.byId.get(id) : undefined;
        return value ? copyTicket(value) : null;
    }
    all() {
        return [...this.byId.values()].map(copyTicket);
    }
}
exports.InMemoryTicketPort = InMemoryTicketPort;
class InMemoryMemberPort extends FailureInjectingPort {
    members = new Map();
    calls = {
        find: 0,
        addRole: 0,
        removeRole: 0,
    };
    seed(guildId, userId, roleIds = []) {
        const value = {
            id: userId,
            guildId,
            roleIds: [...new Set(roleIds)],
        };
        this.members.set(memberScope(guildId, userId), value);
        return copyMember(value);
    }
    async find(guildId, userId, context) {
        this.calls.find += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const value = this.members.get(memberScope(guildId, userId));
        return value ? copyMember(value) : null;
    }
    async addRole(guildId, userId, roleId, context) {
        this.calls.addRole += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const key = memberScope(guildId, userId);
        const old = this.members.get(key);
        if (!old)
            throw new Error(`Unknown member: ${userId}`);
        const value = {
            ...old,
            roleIds: old.roleIds.includes(roleId) ? [...old.roleIds] : [...old.roleIds, roleId],
        };
        this.members.set(key, value);
        return copyMember(value);
    }
    async removeRole(guildId, userId, roleId, context) {
        this.calls.removeRole += 1;
        abortIfNeeded(context);
        this.maybeFail();
        const key = memberScope(guildId, userId);
        const old = this.members.get(key);
        if (!old)
            throw new Error(`Unknown member: ${userId}`);
        const value = {
            ...old,
            roleIds: old.roleIds.filter((id) => id !== roleId),
        };
        this.members.set(key, value);
        return copyMember(value);
    }
}
exports.InMemoryMemberPort = InMemoryMemberPort;
class InMemoryCommercePort {
    members;
    customerRoles;
    grants = new Map();
    nextRequest = 1;
    calls = {
        resolveCustomerRole: 0,
        grantCustomerRole: 0,
    };
    constructor(options) {
        this.members = options.members;
        this.customerRoles = new Map();
        for (const [key, role] of Object.entries(options.customerRoles ?? {})) {
            this.customerRoles.set(key, copyRole(role));
        }
    }
    setCustomerRole(guildId, productKey, role) {
        this.customerRoles.set(productScope(guildId, productKey), copyRole(role));
    }
    async resolveCustomerRole(guildId, productKey, context) {
        this.calls.resolveCustomerRole += 1;
        abortIfNeeded(context);
        const role = this.customerRoles.get(productScope(guildId, productKey));
        return role ? copyRole(role) : null;
    }
    async grantCustomerRole(input, context) {
        this.calls.grantCustomerRole += 1;
        abortIfNeeded(context);
        const previous = this.grants.get(input.idempotencyKey);
        if (previous && previous.outcome !== 'pending_member') {
            return { ...previous, ...(previous.member ? { member: copyMember(previous.member) } : {}) };
        }
        const role = input.roleId
            ? [...this.customerRoles.values()].find((candidate) => candidate.guildId === input.guildId && candidate.id === input.roleId)
            : await this.resolveCustomerRole(input.guildId, input.productKey, context);
        const base = {
            idempotencyKey: input.idempotencyKey,
            guildId: input.guildId,
            userId: input.userId,
            ...(role ? { roleId: role.id } : {}),
        };
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
            const result = {
                ...base,
                outcome: 'pending_member',
            };
            this.grants.set(input.idempotencyKey, result);
            return result;
        }
        const updated = member.roleIds.includes(role.id)
            ? member
            : await this.members.addRole(input.guildId, input.userId, role.id, context);
        const result = {
            ...base,
            outcome: member.roleIds.includes(role.id) ? 'already_granted' : 'granted',
            member: copyMember(updated),
        };
        this.grants.set(input.idempotencyKey, result);
        return result;
    }
    /** Test-only inspection without exposing mutable internal state. */
    grantCount() {
        return this.grants.size;
    }
    nextSyntheticRequestId() {
        return `commerce-request-${this.nextRequest++}`;
    }
}
exports.InMemoryCommercePort = InMemoryCommercePort;
function createInMemoryPorts() {
    const setup = new InMemorySetupPort();
    const tickets = new InMemoryTicketPort();
    const members = new InMemoryMemberPort();
    const commerce = new InMemoryCommercePort({ members });
    return { setup, tickets, members, commerce };
}
exports.createFakePorts = createInMemoryPorts;
