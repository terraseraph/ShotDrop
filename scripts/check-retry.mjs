// Self-check for the sync retry rules: node --experimental-strip-types scripts/check-retry.mjs
import assert from 'node:assert/strict'
import { isUnreachable, offlineDelay } from '../src/main/core/retry.ts'

const err = (props) => Object.assign(new Error(props.message ?? 'x'), props)

// Waits (no retry spent)
for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EIO', 'UNKNOWN']) assert.equal(isUnreachable(err({ code })), true, code)
assert.equal(isUnreachable(err({ unreachable: true })), true)
assert.equal(isUnreachable(err({ exitCode: 5, message: 'whatever' })), true)
assert.equal(isUnreachable(err({ exitCode: 1, message: 'Failed to copy: dial tcp: lookup drive.google.com: no such host' })), true)

// Real errors (count toward the cap)
for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC']) assert.equal(isUnreachable(err({ code })), false, code)
assert.equal(isUnreachable(err({ message: 'size mismatch after copy' })), false)
assert.equal(isUnreachable(err({ exitCode: 1, message: "didn't find section in config file" })), false)
assert.equal(isUnreachable(err({ exitCode: 7, message: 'Fatal error: permission denied' })), false)

// Backoff doubles and caps
assert.equal(offlineDelay(0), 5000)
assert.equal(offlineDelay(1), 10000)
assert.equal(offlineDelay(50), 300000)

console.log('retry rules ok')
