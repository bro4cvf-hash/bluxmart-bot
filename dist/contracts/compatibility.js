"use strict";
/**
 * Compatibility aliases for routes and interaction IDs already present in the
 * live-sync application.
 *
 * Ownership: this module is deliberately descriptive only.  A02 does not
 * register routes or Discord components.  Route adapters may add a new route,
 * but must continue accepting these old paths and IDs during migration.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_CUSTOM_IDS = exports.API_ROUTES = exports.LEGACY_ROUTES = exports.LEGACY_API_ROUTES = void 0;
exports.LEGACY_API_ROUTES = {
    login: '/login',
    logout: '/logout',
    me: '/api/me',
    status: '/api/status',
    guilds: '/api/guilds',
    guild: '/api/guilds/:id',
    template: '/api/template',
    templateDefaults: '/api/template/defaults',
    changePassword: '/api/change-password',
};
exports.LEGACY_ROUTES = exports.LEGACY_API_ROUTES;
exports.API_ROUTES = exports.LEGACY_API_ROUTES;
exports.LEGACY_CUSTOM_IDS = {
    reviewStars: 'review_stars',
    reviewModalPrefix: 'review_modal_',
    reviewText: 'review_text',
    ticketClose: 'ticket_close',
    verifyClick: 'verify_click',
};
