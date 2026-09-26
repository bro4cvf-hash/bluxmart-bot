/**
 * Compatibility aliases for routes and interaction IDs already present in the
 * live-sync application.
 *
 * Ownership: this module is deliberately descriptive only.  A02 does not
 * register routes or Discord components.  Route adapters may add a new route,
 * but must continue accepting these old paths and IDs during migration.
 */

import type { TicketTypeId } from './tickets';

export const LEGACY_API_ROUTES = {
  login: '/login',
  logout: '/logout',
  me: '/api/me',
  status: '/api/status',
  guilds: '/api/guilds',
  guild: '/api/guilds/:id',
  template: '/api/template',
  templateDefaults: '/api/template/defaults',
  changePassword: '/api/change-password',
} as const;

export const LEGACY_ROUTES = LEGACY_API_ROUTES;
export const API_ROUTES = LEGACY_API_ROUTES;
export type LegacyApiRoute = (typeof LEGACY_API_ROUTES)[keyof typeof LEGACY_API_ROUTES];
export type ApiRoute = LegacyApiRoute;

export const LEGACY_CUSTOM_IDS = {
  reviewStars: 'review_stars',
  reviewModalPrefix: 'review_modal_',
  reviewText: 'review_text',
  ticketClose: 'ticket_close',
  verifyClick: 'verify_click',
} as const;

export type LegacyReviewModalCustomId = `review_modal_${'1' | '2' | '3' | '4' | '5'}`;
export type ReviewModalCustomId = LegacyReviewModalCustomId;
export type LegacyTicketTypeCustomId = TicketTypeId;
export type LegacyCustomId =
  | (typeof LEGACY_CUSTOM_IDS)[keyof typeof LEGACY_CUSTOM_IDS]
  | LegacyReviewModalCustomId
  | TicketTypeId;
export type InteractionCustomId = LegacyCustomId;

/** Small route metadata for adapters that want to document auth/CSRF ownership. */
export interface ApiRouteContract {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: ApiRoute;
  readonly authentication: 'required' | 'public';
  readonly csrf: boolean;
}
