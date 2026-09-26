"use strict";
/**
 * Dependency-free contracts shared by the Discord-facing feature modules.
 *
 * Nothing in this file imports discord.js.  The feature modules can therefore
 * use these contracts with the real client, with a small adapter, or with the
 * in-memory fakes in `fakes.ts`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
