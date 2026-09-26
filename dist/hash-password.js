"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const readline_1 = __importDefault(require("readline"));
const auth_1 = require("./auth");
async function prompt(q, hidden = false) {
    const rl = readline_1.default.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
        return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
    }
    // hidden input: mute output
    return new Promise((resolve) => {
        const stdin = process.stdin;
        process.stdout.write(q);
        let val = '';
        const onData = (d) => {
            const s = d.toString('utf-8');
            if (s === '\n' || s === '\r' || s === '\r\n') {
                stdin.removeListener('data', onData);
                if (stdin.isTTY)
                    stdin.setRawMode(false);
                process.stdout.write('\n');
                rl.close();
                resolve(val);
            }
            else if (d[0] === 3) {
                process.exit(1);
            }
            else if (d[0] === 127 || d[0] === 8) {
                val = val.slice(0, -1);
            }
            else {
                val += s;
            }
        };
        if (stdin.isTTY)
            stdin.setRawMode(true);
        stdin.resume();
        stdin.on('data', onData);
    });
}
async function main() {
    const args = process.argv.slice(2);
    const save = args.includes('--save');
    const userArg = args.find((a) => a.startsWith('--user='))?.split('=')[1];
    const username = userArg ?? (await prompt('Admin username: ')).trim();
    if (!username) {
        console.error('Username required.');
        process.exit(1);
    }
    const pw1 = await prompt('New password (min 10 chars): ', true);
    const pw2 = await prompt('Confirm password: ', true);
    if (pw1 !== pw2) {
        console.error('Passwords do not match.');
        process.exit(1);
    }
    if (pw1.length < 10) {
        console.error('Password must be at least 10 characters.');
        process.exit(1);
    }
    const hash = (0, auth_1.hashPassword)(pw1);
    console.log('\n--- Add to .env ---');
    console.log(`DASHBOARD_USER=${username}`);
    console.log(`DASHBOARD_PASS_HASH=${hash}`);
    if (save) {
        await (0, auth_1.saveAdminFile)(username, hash);
        console.log('\nSaved to data/admin.json');
    }
    else {
        console.log('\(Tip: re-run with --save to write data/admin.json instead of .env)');
    }
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
