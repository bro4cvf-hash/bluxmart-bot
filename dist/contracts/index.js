"use strict";
/**
 * Public contract surface for the live-sync application.
 *
 * Consumers should import from this module (or a focused submodule) rather
 * than reaching into another agent's implementation.  The exports are
 * framework-light: no Discord, Express, filesystem, or payment SDK types are
 * required.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./primitives"), exports);
__exportStar(require("./keys"), exports);
__exportStar(require("./errors"), exports);
__exportStar(require("./persistence"), exports);
__exportStar(require("./sync"), exports);
__exportStar(require("./discord"), exports);
__exportStar(require("./tickets"), exports);
__exportStar(require("./commerce"), exports);
__exportStar(require("./compatibility"), exports);
