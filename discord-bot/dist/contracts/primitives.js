"use strict";
/**
 * Small, transport-neutral primitives shared by the contract modules.
 *
 * Ownership: this module owns names for opaque identifiers and safe transport
 * values only.  It deliberately has no Discord, HTTP framework, filesystem, or
 * commerce-provider dependency.  Implementations must validate the formats of
 * these strings at their boundaries rather than relying on TypeScript types at
 * runtime.
 */
Object.defineProperty(exports, "__esModule", { value: true });
